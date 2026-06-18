import { describe, expect, it } from "bun:test";
import { edit } from "@/content/edit";
import { reply } from "@/content/reply";
import { type Unsend, unsend } from "@/content/unsend";
import type { Message } from "@/types/message";

const UNDEFINED_TARGET = /unsend\(\) target is undefined/;
const INBOUND_TARGET = /must be an outbound message/;
const REPLY_CANNOT_WRAP = /reply\(\) cannot wrap "unsend"/;
const EDIT_CANNOT_WRAP = /edit\(\) cannot wrap "unsend"/;

const makeMessage = (direction: "inbound" | "outbound"): Message =>
  ({
    id: "m1",
    content: { type: "text", text: "hi" },
    direction,
  }) as unknown as Message;

describe("unsend builder", () => {
  it("builds an unsend value targeting an outbound message", async () => {
    const target = makeMessage("outbound");
    const built = (await unsend(target).build()) as Unsend;

    expect(built.type).toBe("unsend");
    // Identity: the target passes through schema parsing untouched.
    expect(built.target).toBe(target);
  });

  it("accepts an unnarrowed send result and throws a clear error when it is undefined", async () => {
    // `space.send` resolves `undefined` when a platform skips unsupported
    // content; the builder accepts that union so chained sends compile, and
    // fails with a descriptive error at build time instead.
    await expect(unsend(undefined).build()).rejects.toThrow(UNDEFINED_TARGET);
  });

  it("rejects inbound targets at build time", async () => {
    await expect(unsend(makeMessage("inbound")).build()).rejects.toThrow(
      INBOUND_TARGET
    );
  });

  it("cannot be wrapped by reply()", async () => {
    const inner = unsend(makeMessage("outbound"));
    await expect(reply(inner, makeMessage("inbound")).build()).rejects.toThrow(
      REPLY_CANNOT_WRAP
    );
  });

  it("cannot be wrapped by edit()", async () => {
    const inner = unsend(makeMessage("outbound"));
    await expect(edit(inner, makeMessage("outbound")).build()).rejects.toThrow(
      EDIT_CANNOT_WRAP
    );
  });
});
