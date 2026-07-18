import type {
  AdvancedIMessage,
  MiniAppCardSession,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage/grpc";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { imessage } from "@/index";
import type { IMessageMessage, RemoteClient } from "@/types";

const PHONE = "+15550100";
const CHILD_ID_PREFIX = /^p:(\d+)\//;
const SPACE = { id: "any;-;+15551234", phone: PHONE, type: "dm" } as const;
const ctx = { config: {} as never, store: undefined as never };
const def = imessage.config({}).__definition;

const sdkMessage = (guid: string): SDKMessage =>
  ({ dateCreated: new Date(0), guid }) as SDKMessage;

const clients = (
  direct: AdvancedIMessage,
  resourceClient: AdvancedIMessage
): RemoteClient[] => [
  {
    client: direct,
    instanceId: "instance-1",
    phone: PHONE,
    resourceClient,
  },
];

const target = (id: string, parentId?: string): IMessageMessage =>
  ({
    content: { text: "hello", type: "text" },
    id,
    parentId,
    partIndex: parentId ? Number(id.match(CHILD_ID_PREFIX)?.[1]) : undefined,
    sender: { id: "+15551234" },
    space: SPACE,
    timestamp: new Date(0),
  }) as IMessageMessage;

const appContent = (): Content =>
  ({
    layout: () => Promise.resolve({ caption: "Updated" }),
    type: "app",
    url: () => Promise.resolve("https://example.com/card"),
  }) as unknown as Content;

describe("iMessage dedicated virtual resource actions", () => {
  it("routes replies and reactions for virtual child messages through Spectrum", async () => {
    const directSend = vi.fn();
    const directReaction = vi.fn();
    const proxySend = vi.fn(() => Promise.resolve(sdkMessage("reply-guid")));
    const proxyReaction = vi.fn(() =>
      Promise.resolve(sdkMessage("reaction-guid"))
    );
    const direct = {
      messages: { sendText: directSend, setReaction: directReaction },
    } as unknown as AdvancedIMessage;
    const proxy = {
      messages: { sendText: proxySend, setReaction: proxyReaction },
    } as unknown as AdvancedIMessage;
    const virtualTarget = target("p:2/spc-msg-parent", "spc-msg-parent");

    await def.send({
      ...ctx,
      client: clients(direct, proxy),
      content: {
        content: { text: "reply", type: "text" },
        target: virtualTarget,
        type: "reply",
      } as never,
      space: SPACE,
    });
    await def.send({
      ...ctx,
      client: clients(direct, proxy),
      content: {
        emoji: "👍",
        target: virtualTarget,
        type: "reaction",
      } as never,
      space: SPACE,
    });

    expect(proxySend).toHaveBeenCalledWith(
      SPACE.id,
      "reply",
      expect.objectContaining({
        replyTo: { guid: "spc-msg-parent", partIndex: 2 },
      })
    );
    expect(proxyReaction).toHaveBeenCalledWith(
      SPACE.id,
      "spc-msg-parent",
      { kind: "like" },
      true,
      { partIndex: 2 }
    );
    expect(directSend).not.toHaveBeenCalled();
    expect(directReaction).not.toHaveBeenCalled();
  });

  it("routes edit, unsend, and reaction removal by virtual message id", async () => {
    const directEdit = vi.fn();
    const directUnsend = vi.fn();
    const directReaction = vi.fn();
    const proxyEdit = vi.fn(() => Promise.resolve(sdkMessage("edited")));
    const proxyUnsend = vi.fn(() => Promise.resolve());
    const proxyReaction = vi.fn(() =>
      Promise.resolve(sdkMessage("reaction-guid"))
    );
    const direct = {
      messages: {
        edit: directEdit,
        setReaction: directReaction,
        unsend: directUnsend,
      },
    } as unknown as AdvancedIMessage;
    const proxy = {
      messages: {
        edit: proxyEdit,
        setReaction: proxyReaction,
        unsend: proxyUnsend,
      },
    } as unknown as AdvancedIMessage;
    const virtualTarget = target("p:4/spc-msg-parent", "spc-msg-parent");

    await def.send({
      ...ctx,
      client: clients(direct, proxy),
      content: {
        content: { text: "edited", type: "text" },
        target: virtualTarget,
        type: "edit",
      } as never,
      space: SPACE,
    });
    await def.send({
      ...ctx,
      client: clients(direct, proxy),
      content: { target: virtualTarget, type: "unsend" } as never,
      space: SPACE,
    });
    await def.send({
      ...ctx,
      client: clients(direct, proxy),
      content: {
        target: {
          content: {
            emoji: "👍",
            target: virtualTarget,
            type: "reaction",
          },
          id: "reaction-record",
        },
        type: "unsend",
      } as never,
      space: SPACE,
    });

    expect(proxyEdit).toHaveBeenCalledWith(
      SPACE.id,
      "spc-msg-parent",
      "edited",
      { partIndex: 4 }
    );
    expect(proxyUnsend).toHaveBeenCalledWith(SPACE.id, "spc-msg-parent", {
      partIndex: 4,
    });
    expect(proxyReaction).toHaveBeenCalledWith(
      SPACE.id,
      "spc-msg-parent",
      { kind: "like" },
      false,
      { partIndex: 4 }
    );
    expect(directEdit).not.toHaveBeenCalled();
    expect(directUnsend).not.toHaveBeenCalled();
    expect(directReaction).not.toHaveBeenCalled();
  });

  it("routes getMessage and getAttachment through Spectrum for virtual ids", async () => {
    const directGetMessage = vi.fn();
    const directGetAttachment = vi.fn();
    const proxyGetMessage = vi.fn(() =>
      Promise.resolve({
        chatGuids: [SPACE.id],
        content: {
          attachments: [
            {
              fileName: "photo.png",
              guid: "spc-att-photo",
              isHidden: false,
              isOutgoing: false,
              isSticker: false,
              mimeType: "image/png",
              totalBytes: 123,
              transferState: 0,
              uti: "public.png",
            },
          ],
          formatting: [],
          mentions: [],
          text: "hi \uFFFC",
        },
        dateCreated: new Date(0),
        guid: "spc-msg-parent",
        isFromMe: false,
      })
    );
    const proxyGetAttachment = vi.fn(() =>
      Promise.resolve({
        fileName: "photo.png",
        guid: "spc-att-photo",
        mimeType: "image/png",
        totalBytes: 123,
      })
    );
    const direct = {
      attachments: { get: directGetAttachment },
      messages: { get: directGetMessage },
    } as unknown as AdvancedIMessage;
    const proxy = {
      attachments: { get: proxyGetAttachment },
      messages: { get: proxyGetMessage },
    } as unknown as AdvancedIMessage;
    const entries = clients(direct, proxy);
    const getMessage = def.actions?.getMessage;
    const getAttachment = def.actions?.getAttachment;
    if (!(getMessage && getAttachment)) {
      throw new Error("iMessage resource actions are missing");
    }

    const message = await getMessage(
      { ...ctx, client: entries },
      { ...SPACE, __platform: "iMessage" },
      "p:1/spc-msg-parent"
    );
    const attachment = await getAttachment(
      { ...ctx, client: entries },
      "spc-att-photo",
      PHONE
    );

    expect(message).toMatchObject({
      id: "p:1/spc-msg-parent",
      parentId: "spc-msg-parent",
    });
    expect(attachment).toMatchObject({ id: "spc-att-photo" });
    expect(proxyGetMessage).toHaveBeenCalledWith("spc-msg-parent");
    expect(proxyGetAttachment).toHaveBeenCalledWith("spc-att-photo");
    expect(directGetMessage).not.toHaveBeenCalled();
    expect(directGetAttachment).not.toHaveBeenCalled();
  });

  it("routes virtual mini-app sessions through Spectrum", async () => {
    const session = {
      chatGuid: SPACE.id,
      messageGuid: "spc-msg-card",
      sessionId: "session-1",
      targetMessageGuid: "spc-msg-target",
    } satisfies MiniAppCardSession;
    const directUpdate = vi.fn();
    const proxyUpdate = vi.fn(() =>
      Promise.resolve({
        dateCreated: new Date(0),
        guid: "spc-msg-updated",
        miniAppCardSession: session,
      })
    );
    const direct = {
      messages: { updateCustomizedMiniApp: directUpdate },
    } as unknown as AdvancedIMessage;
    const proxy = {
      messages: { updateCustomizedMiniApp: proxyUpdate },
    } as unknown as AdvancedIMessage;

    await def.send({
      ...ctx,
      client: clients(direct, proxy),
      content: {
        content: appContent(),
        target: {
          ...target("spc-msg-card"),
          miniAppCardSession: session,
        },
        type: "edit",
      } as never,
      space: SPACE,
    });

    expect(proxyUpdate).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ url: "https://example.com/card" })
    );
    expect(directUpdate).not.toHaveBeenCalled();
  });

  it("keeps ordinary native message operations on the dedicated instance", async () => {
    const directUnsend = vi.fn(() => Promise.resolve());
    const proxyUnsend = vi.fn();
    const direct = {
      messages: { unsend: directUnsend },
    } as unknown as AdvancedIMessage;
    const proxy = {
      messages: { unsend: proxyUnsend },
    } as unknown as AdvancedIMessage;

    await def.send({
      ...ctx,
      client: clients(direct, proxy),
      content: { target: target("native-message"), type: "unsend" } as never,
      space: SPACE,
    });

    expect(directUnsend).toHaveBeenCalledWith(
      SPACE.id,
      "native-message",
      undefined
    );
    expect(proxyUnsend).not.toHaveBeenCalled();
  });
});
