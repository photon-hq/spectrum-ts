import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openState } from "@/state";
import { BASE_URL, memoryStore } from "./helpers";

const OWNER_ONLY = 0o600;
// The low nine mode bits are the permissions.
const PERMISSION_RANGE = 0o1000;
const NOT_JSON = /not valid JSON/;
const BAD_SHAPE = /unexpected shape/;

const credentials = { botToken: "tok-1", baseUrl: BASE_URL, botId: "bot" };

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spectrum-wechat-"));
  file = join(dir, "nested", "state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openState", () => {
  it("keeps state in the store when no file is configured", async () => {
    const state = await openState(memoryStore());

    state.setCredentials(credentials);
    state.setCursor("cursor-1");
    state.setContextToken("u1", "ctx-1");
    await state.save();

    expect(state.credentials()).toEqual(credentials);
    expect(state.cursor()).toBe("cursor-1");
    expect(state.contextToken("u1")).toBe("ctx-1");
  });

  it("starts empty when the file does not exist yet", async () => {
    const state = await openState(memoryStore(), file);

    expect(state.credentials()).toBeUndefined();
    expect(state.cursor()).toBe("");
    expect(state.contextToken("u1")).toBeUndefined();
  });

  it("round-trips credentials, cursor and context tokens", async () => {
    const first = await openState(memoryStore(), file);
    first.setCredentials(credentials);
    first.setCursor("cursor-1");
    first.setContextToken("u1", "ctx-1");
    await first.save();

    const second = await openState(memoryStore(), file);

    expect(second.credentials()).toEqual(credentials);
    expect(second.cursor()).toBe("cursor-1");
    expect(second.contextToken("u1")).toBe("ctx-1");
  });

  it("writes the file readable by its owner only", async () => {
    const state = await openState(memoryStore(), file);
    state.setCredentials(credentials);
    await state.save();

    const { mode } = await stat(file);
    expect(mode % PERMISSION_RANGE).toBe(OWNER_ONLY);
  });

  it("drops the old bot's cursor and tokens when the token changes", async () => {
    const state = await openState(memoryStore());
    state.setCredentials(credentials);
    state.setCursor("cursor-1");
    state.setContextToken("u1", "ctx-1");

    state.setCredentials({ ...credentials, botToken: "tok-2" });

    expect(state.cursor()).toBe("");
    expect(state.contextToken("u1")).toBeUndefined();
  });

  it("does not rewrite the file when nothing changed", async () => {
    const state = await openState(memoryStore(), file);
    state.setCursor("cursor-1");
    await state.save();
    await writeFile(file, "sentinel");

    state.setCursor("cursor-1");
    await state.save();

    expect(await readFile(file, "utf8")).toBe("sentinel");
  });

  it("rejects a malformed state file", async () => {
    await writeFile(join(dir, "bad.json"), "{nope");

    await expect(
      openState(memoryStore(), join(dir, "bad.json"))
    ).rejects.toThrow(NOT_JSON);
  });

  it("rejects a state file with the wrong shape", async () => {
    await writeFile(join(dir, "old.json"), JSON.stringify({ version: 99 }));

    await expect(
      openState(memoryStore(), join(dir, "old.json"))
    ).rejects.toThrow(BAD_SHAPE);
  });
});
