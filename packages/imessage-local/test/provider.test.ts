import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { imessage, nativeContactCard } from "@/index";

const LOCAL_MODE_ERROR = /local mode/;
const LOCAL_GROUP_ERROR = /local mode cannot create group chats/;

const def = imessage.config().__definition;
const localClient = (send = vi.fn((_: unknown) => Promise.resolve())) =>
  Object.assign(Object.create(IMessageSDK.prototype), { send }) as IMessageSDK;

const ctx = {
  client: localClient(),
  config: {},
  store: undefined as never,
};

const appContent = (url: string): Content =>
  ({
    type: "app",
    live: false,
    url: () => Promise.resolve(url),
    layout: () => Promise.resolve({}),
  }) as Content;

describe("@spectrum-ts/imessage-local", () => {
  it("constructs the provider with config()", () => {
    expect(imessage.config()).toMatchObject({
      __tag: "PlatformProviderConfig",
    });
  });

  it("creates deterministic local DMs", async () => {
    await expect(
      def.space.create({
        ...ctx,
        input: { users: [{ id: "+15550123" }] },
      })
    ).resolves.toEqual({
      id: "any;-;+15550123",
      type: "dm",
      phone: "",
    });
  });

  it("rejects local group creation", async () => {
    await expect(
      def.space.create({
        ...ctx,
        input: { users: [{ id: "a@example.com" }, { id: "b@example.com" }] },
      })
    ).rejects.toThrow(LOCAL_GROUP_ERROR);
  });

  it("derives local chat types without accessing the database", async () => {
    await expect(
      def.space.get?.({
        ...ctx,
        input: { id: "iMessage;+;chat42" },
      })
    ).resolves.toEqual({
      id: "iMessage;+;chat42",
      type: "group",
      phone: "",
    });
  });

  it("sends ordinary content through imessage-kit", async () => {
    const send = vi.fn((_: unknown) => Promise.resolve());

    await def.send({
      ...ctx,
      client: localClient(send),
      content: { type: "text", text: "hello" },
      space: { id: "any;-;+15550123", type: "dm", phone: "" },
    });

    expect(send).toHaveBeenCalledWith({
      to: "any;-;+15550123",
      text: "hello",
    });
  });

  it("degrades app content to its URL", async () => {
    const send = vi.fn((_: unknown) => Promise.resolve());

    await def.send({
      ...ctx,
      client: localClient(send),
      content: appContent("https://example.com/app"),
      space: { id: "any;-;+15550123", type: "dm", phone: "" },
    });

    expect(send).toHaveBeenCalledWith({
      to: "any;-;+15550123",
      text: "https://example.com/app",
    });
  });

  it("preserves remote-only unsupported errors", async () => {
    await expect(
      def.send({
        ...ctx,
        content: await nativeContactCard().build(),
        space: { id: "any;-;+15550123", type: "dm", phone: "" },
      })
    ).rejects.toThrow(LOCAL_MODE_ERROR);
  });
});
