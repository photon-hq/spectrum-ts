import type { Message } from "@spectrum-ts/core";
import { asRead } from "@spectrum-ts/core/authoring";
import { describe, expect, it } from "vitest";
import { send } from "@/messages";

const target = {
  id: "1700000000.000100",
  content: { type: "text", text: "hi" },
  direction: "inbound",
} as unknown as Message;

describe("slack send — read", () => {
  it("silently no-ops (Slack has no user-visible read receipts)", async () => {
    // The read branch returns before touching the client or space, so a
    // never-client proves no API interaction happens.
    const result = await send(
      undefined as never,
      { id: "C1", teamId: "T1" } as Parameters<typeof send>[1],
      asRead({ target })
    );
    expect(result).toBeUndefined();
  });
});
