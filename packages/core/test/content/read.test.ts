import { describe, expect, it } from "bun:test";
import { edit } from "@/content/edit";
import { type Read, read } from "@/content/read";
import { reply } from "@/content/reply";
import type { Message } from "@/types/message";

const OUTBOUND_TARGET = /must be an inbound message/;
const REPLY_CANNOT_WRAP = /reply\(\) cannot wrap "read"/;
const EDIT_CANNOT_WRAP = /edit\(\) cannot wrap "read"/;

const makeMessage = (direction: "inbound" | "outbound"): Message =>
  ({
    id: "m1",
    content: { type: "text", text: "hi" },
    direction,
  }) as unknown as Message;

describe("read builder", () => {
  it("builds a read value targeting an inbound message", async () => {
    const target = makeMessage("inbound");
    const built = (await read(target).build()) as Read;

    expect(built.type).toBe("read");
    // Identity: the target passes through schema parsing untouched.
    expect(built.target).toBe(target);
  });

  it("rejects outbound targets at build time", async () => {
    await expect(read(makeMessage("outbound")).build()).rejects.toThrow(
      OUTBOUND_TARGET
    );
  });

  it("cannot be wrapped by reply()", async () => {
    const inner = read(makeMessage("inbound"));
    await expect(reply(inner, makeMessage("inbound")).build()).rejects.toThrow(
      REPLY_CANNOT_WRAP
    );
  });

  it("cannot be wrapped by edit()", async () => {
    const inner = read(makeMessage("inbound"));
    await expect(edit(inner, makeMessage("outbound")).build()).rejects.toThrow(
      EDIT_CANNOT_WRAP
    );
  });
});
