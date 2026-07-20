import type {
  AdvancedIMessage,
  MiniAppCardSession,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage/http";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { imessage } from "@/index";
import type { IMessageMessage, RemoteClient } from "@/types";

const PHONE = "+15550100";
const OTHER_PHONE = "+15550101";
const LINE_ID = "2c9031e5-a26d-4707-8e52-d81241af6722";
const OTHER_LINE_ID = "c9764f28-cd87-4305-8bf6-c586dccd7fc5";
const CHILD_ID_PREFIX = /^p:(\d+)\//;
const SPACE = {
  id: "any;-;+15551234",
  lineId: LINE_ID,
  phone: PHONE,
  type: "dm",
} as const;
const ctx = { config: {} as never, store: undefined as never };
const def = imessage.config({}).__definition;

const sdkMessage = (guid: string): SDKMessage =>
  ({ dateCreated: new Date(0), guid }) as SDKMessage;

const clients = (
  client: AdvancedIMessage,
  resourceClient?: AdvancedIMessage,
  phone = PHONE
): RemoteClient[] => [{ client, lineId: LINE_ID, phone, resourceClient }];

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

describe("iMessage HTTP resource actions", () => {
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
      space: { lineId: LINE_ID },
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

  it("passes native message ids through on the selected line", async () => {
    const unsend = vi.fn(() => Promise.resolve());
    const remote = {
      messages: { unsend },
    } as unknown as AdvancedIMessage;

    await def.send({
      ...ctx,
      client: clients(remote),
      content: { target: target("native-message"), type: "unsend" } as never,
      space: SPACE,
    });

    expect(unsend).toHaveBeenCalledWith(SPACE.id, "native-message", undefined);
  });

  it("routes multi-line resource actions to the exact line and phone client", async () => {
    const firstUnsend = vi.fn(() => Promise.resolve());
    const secondUnsend = vi.fn(() => Promise.resolve());
    const first = {
      messages: { unsend: firstUnsend },
    } as unknown as AdvancedIMessage;
    const second = {
      messages: { unsend: secondUnsend },
    } as unknown as AdvancedIMessage;
    const entries: RemoteClient[] = [
      { client: first, lineId: LINE_ID, phone: PHONE },
      {
        client: second,
        lineId: OTHER_LINE_ID,
        phone: OTHER_PHONE,
      },
    ];

    await def.send({
      ...ctx,
      client: entries,
      content: { target: target("native-message"), type: "unsend" } as never,
      space: { ...SPACE, lineId: OTHER_LINE_ID, phone: OTHER_PHONE },
    });

    expect(secondUnsend).toHaveBeenCalledWith(
      SPACE.id,
      "native-message",
      undefined
    );
    expect(firstUnsend).not.toHaveBeenCalled();
  });

  it("rejects a space whose dedicated line id and phone disagree", async () => {
    const firstUnsend = vi.fn(() => Promise.resolve());
    const secondUnsend = vi.fn(() => Promise.resolve());
    const entries: RemoteClient[] = [
      {
        client: {
          messages: { unsend: firstUnsend },
        } as unknown as AdvancedIMessage,
        lineId: LINE_ID,
        phone: PHONE,
      },
      {
        client: {
          messages: { unsend: secondUnsend },
        } as unknown as AdvancedIMessage,
        lineId: OTHER_LINE_ID,
        phone: OTHER_PHONE,
      },
    ];

    await expect(
      def.send({
        ...ctx,
        client: entries,
        content: { target: target("native-message"), type: "unsend" } as never,
        space: { ...SPACE, phone: OTHER_PHONE },
      })
    ).rejects.toThrow(
      `No iMessage client serves line ${LINE_ID} at phone ${OTHER_PHONE}`
    );
    expect(firstUnsend).not.toHaveBeenCalled();
    expect(secondUnsend).not.toHaveBeenCalled();
  });

  it("routes a pre-migration space without lineId by its unique phone", async () => {
    const firstUnsend = vi.fn(() => Promise.resolve());
    const secondUnsend = vi.fn(() => Promise.resolve());
    const entries: RemoteClient[] = [
      {
        client: {
          messages: { unsend: firstUnsend },
        } as unknown as AdvancedIMessage,
        lineId: LINE_ID,
        phone: PHONE,
      },
      {
        client: {
          messages: { unsend: secondUnsend },
        } as unknown as AdvancedIMessage,
        lineId: OTHER_LINE_ID,
        phone: OTHER_PHONE,
      },
    ];

    await def.send({
      ...ctx,
      client: entries,
      content: { target: target("native-message"), type: "unsend" } as never,
      space: { id: SPACE.id, phone: OTHER_PHONE, type: SPACE.type },
    });

    expect(secondUnsend).toHaveBeenCalledWith(
      SPACE.id,
      "native-message",
      undefined
    );
    expect(firstUnsend).not.toHaveBeenCalled();
  });

  it("uses the shared HTTP client for retained virtual ids", async () => {
    const unsend = vi.fn(() => Promise.resolve());
    const shared = {
      messages: { unsend },
    } as unknown as AdvancedIMessage;
    const sharedSpace = { ...SPACE, lineId: undefined, phone: "shared" };

    await def.send({
      ...ctx,
      client: [{ client: shared, phone: "shared" }],
      content: {
        target: target("p:3/spc-msg-parent", "spc-msg-parent"),
        type: "unsend",
      } as never,
      space: sharedSpace,
    });

    expect(unsend).toHaveBeenCalledWith(SPACE.id, "spc-msg-parent", {
      partIndex: 3,
    });
  });
});
