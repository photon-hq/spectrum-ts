import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChatDisplayName } from "@/client";
import { configSchema } from "@/config";

const config = configSchema.parse({ botToken: "1:abc" });

let lastUrl: string;
let chatResult: Record<string, unknown>;

beforeEach(() => {
  lastUrl = "";
  const impl = (input: Request): Promise<Response> => {
    lastUrl = input.url;
    return Promise.resolve(Response.json({ ok: true, result: chatResult }));
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getChatDisplayName", () => {
  it("returns the title for a group chat and calls getChat", async () => {
    chatResult = { id: 100, type: "supergroup", title: "Team Chat" };

    const name = await getChatDisplayName(config, "100");

    expect(name).toBe("Team Chat");
    expect(lastUrl.endsWith("/getChat")).toBe(true);
  });

  it("resolves undefined for a private chat (no title)", async () => {
    chatResult = { id: 42, type: "private", first_name: "Ada" };

    expect(await getChatDisplayName(config, "42")).toBeUndefined();
  });
});
