import { beforeEach, describe, expect, it, mock } from "bun:test";

// pin.ts builds a REST client and calls the pin helpers. Stub those so each
// call's channel/message ids are observable. (pin.ts imports them via
// "../client", the same module this aliases.)
const pinMessageMock = mock(
  (_client: unknown, _channelId: string, _messageId: string): Promise<void> =>
    Promise.resolve()
);

const unpinMessageMock = mock(
  (_client: unknown, _channelId: string, _messageId: string): Promise<void> =>
    Promise.resolve()
);

mock.module("@/client", () => ({
  discordClient: () => ({}),
  pinMessage: pinMessageMock,
  unpinMessage: unpinMessageMock,
}));

import type { Message } from "@spectrum-ts/core";
import { configSchema } from "@/config";
import { pin, unpin } from "@/outbound/pin";

const config = configSchema.parse({
  botToken: "abc.def.ghi",
  applicationId: "999",
});

// A minimal stand-in: `pin`/`unpin` only read `id` and `space.id`.
const stubMessage = (id: string, channelId: string): Message =>
  ({ id, space: { id: channelId } }) as unknown as Message;

beforeEach(() => {
  pinMessageMock.mockReset();
  pinMessageMock.mockResolvedValue(undefined);
  unpinMessageMock.mockReset();
  unpinMessageMock.mockResolvedValue(undefined);
});

describe("pin", () => {
  it("pins a message using its channel and message snowflakes", async () => {
    await pin({ config, message: stubMessage("5", "100") });
    expect(pinMessageMock).toHaveBeenCalledTimes(1);
    const [, channelId, messageId] = pinMessageMock.mock.calls.at(0) ?? [];
    expect(channelId).toBe("100");
    expect(messageId).toBe("5");
  });

  it("resolves a flattened group-item id to the underlying snowflake", async () => {
    await pin({ config, message: stubMessage("5:1", "100") });
    const [, , messageId] = pinMessageMock.mock.calls.at(0) ?? [];
    expect(messageId).toBe("5");
  });
});

describe("unpin", () => {
  it("unpins a message using its channel and message snowflakes", async () => {
    await unpin({ config, message: stubMessage("7", "200") });
    expect(unpinMessageMock).toHaveBeenCalledTimes(1);
    const [, channelId, messageId] = unpinMessageMock.mock.calls.at(0) ?? [];
    expect(channelId).toBe("200");
    expect(messageId).toBe("7");
  });
});
