import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Space } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { isContactCard } from "@/content/contact-card";
import { imessage, nativeContactCard } from "@/index";
import { shareContactCard as remoteShareContactCard } from "@/remote/contact-card";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const LOCAL_MODE_ERROR = /local mode/;

const SIGNAL = {
  type: "contactCard",
  __platform: "iMessage",
  __fireAndForget: true,
} as const;

const def = imessage.config({}).__definition;

const ctx = {
  config: {} as never,
  store: undefined as never,
};

const sharedClient = (
  shareContactInfo: (chat: string) => Promise<void>
): RemoteClient[] => [
  {
    phone: SHARED_PHONE,
    client: { chats: { shareContactInfo } } as unknown as AdvancedIMessage,
  },
];

describe("nativeContactCard content", () => {
  it("builds the iMessage contact-card control signal", async () => {
    // `build()` returns the universal `Content` union, which intentionally
    // excludes the iMessage-only `contactCard` signal — widen to compare.
    expect((await nativeContactCard().build()) as unknown).toEqual(SIGNAL);
  });

  it("isContactCard accepts the built signal and rejects everything else", async () => {
    expect(isContactCard(await nativeContactCard().build())).toBe(true);
    expect(isContactCard({ type: "text", text: "hi" })).toBe(false);
    // Missing the framework tags — not a valid control signal.
    expect(isContactCard({ type: "contactCard" })).toBe(false);
  });
});

describe("iMessage remote shareContactCard", () => {
  it("forwards the chat guid to chats.shareContactInfo", async () => {
    const shareContactInfo = vi.fn((_: string) => Promise.resolve());
    const remote = {
      chats: { shareContactInfo },
    } as unknown as AdvancedIMessage;

    await remoteShareContactCard(remote, "any;-;+15550123");

    expect(shareContactInfo).toHaveBeenCalledTimes(1);
    expect(shareContactInfo).toHaveBeenCalledWith("any;-;+15550123");
  });
});

describe("iMessage send: contactCard dispatch", () => {
  it("routes the signal to chats.shareContactInfo and is fire-and-forget", async () => {
    const shareContactInfo = vi.fn((_: string) => Promise.resolve());

    const result = await def.send({
      ...ctx,
      client: sharedClient(shareContactInfo),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: await nativeContactCard().build(),
    });

    expect(result).toBeUndefined();
    expect(shareContactInfo).toHaveBeenCalledWith("any;-;+15550123");
  });

  it("is unsupported in local mode", async () => {
    const localClient = Object.create(IMessageSDK.prototype) as IMessageSDK;

    await expect(
      def.send({
        ...ctx,
        client: localClient,
        space: { id: "any;-;x", type: "dm", phone: SHARED_PHONE },
        content: await nativeContactCard().build(),
      })
    ).rejects.toThrow(LOCAL_MODE_ERROR);
  });
});

describe("space.shareContactCard sugar", () => {
  it("dispatches the contact-card content through space.send", async () => {
    const send = vi.fn((_: unknown) => Promise.resolve(undefined));
    const action = def.space.actions?.shareContactCard;
    expect(action).toBeDefined();

    await action?.({ send } as unknown as Space);

    expect(send).toHaveBeenCalledTimes(1);
    const builder = send.mock.calls[0]?.[0] as {
      build: () => Promise<unknown>;
    };
    expect(await builder.build()).toEqual(SIGNAL);
  });
});
