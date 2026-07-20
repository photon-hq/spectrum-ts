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

const clients = (client: AdvancedIMessage): RemoteClient[] => [
  { client, lineId: LINE_ID, phone: PHONE },
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

describe("iMessage HTTP resource actions", () => {
  it("routes native replies and reactions through the selected dedicated line", async () => {
    const sendText = vi.fn(() => Promise.resolve(sdkMessage("reply-guid")));
    const setReaction = vi.fn(() =>
      Promise.resolve(sdkMessage("reaction-guid"))
    );
    const remote = {
      messages: { sendText, setReaction },
    } as unknown as AdvancedIMessage;
    const nativeTarget = target("p:2/native-parent", "native-parent");

    await def.send({
      ...ctx,
      client: clients(remote),
      content: {
        content: { text: "reply", type: "text" },
        target: nativeTarget,
        type: "reply",
      } as never,
      space: SPACE,
    });
    await def.send({
      ...ctx,
      client: clients(remote),
      content: {
        emoji: "👍",
        target: nativeTarget,
        type: "reaction",
      } as never,
      space: SPACE,
    });

    expect(sendText).toHaveBeenCalledWith(
      SPACE.id,
      "reply",
      expect.objectContaining({
        replyTo: { guid: "native-parent", partIndex: 2 },
      })
    );
    expect(setReaction).toHaveBeenCalledWith(
      SPACE.id,
      "native-parent",
      { kind: "like" },
      true,
      { partIndex: 2 }
    );
  });

  it("routes native edit, unsend, and reaction removal through the selected dedicated line", async () => {
    const edit = vi.fn(() => Promise.resolve(sdkMessage("edited")));
    const unsend = vi.fn(() => Promise.resolve());
    const setReaction = vi.fn(() =>
      Promise.resolve(sdkMessage("reaction-guid"))
    );
    const remote = {
      messages: { edit, setReaction, unsend },
    } as unknown as AdvancedIMessage;
    const nativeTarget = target("p:4/native-parent", "native-parent");

    await def.send({
      ...ctx,
      client: clients(remote),
      content: {
        content: { text: "edited", type: "text" },
        target: nativeTarget,
        type: "edit",
      } as never,
      space: SPACE,
    });
    await def.send({
      ...ctx,
      client: clients(remote),
      content: { target: nativeTarget, type: "unsend" } as never,
      space: SPACE,
    });
    await def.send({
      ...ctx,
      client: clients(remote),
      content: {
        target: {
          content: {
            emoji: "👍",
            target: nativeTarget,
            type: "reaction",
          },
          id: "reaction-record",
        },
        type: "unsend",
      } as never,
      space: SPACE,
    });

    expect(edit).toHaveBeenCalledWith(SPACE.id, "native-parent", "edited", {
      partIndex: 4,
    });
    expect(unsend).toHaveBeenCalledWith(SPACE.id, "native-parent", {
      partIndex: 4,
    });
    expect(setReaction).toHaveBeenCalledWith(
      SPACE.id,
      "native-parent",
      { kind: "like" },
      false,
      { partIndex: 4 }
    );
  });

  it("gets native messages and attachments from the selected dedicated line", async () => {
    const getMessageRemote = vi.fn(() =>
      Promise.resolve({
        chatGuids: [SPACE.id],
        content: {
          attachments: [
            {
              fileName: "photo.png",
              guid: "native-attachment",
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
        guid: "native-parent",
        isFromMe: false,
      })
    );
    const getAttachmentRemote = vi.fn(() =>
      Promise.resolve({
        fileName: "photo.png",
        guid: "native-attachment",
        mimeType: "image/png",
        totalBytes: 123,
      })
    );
    const remote = {
      attachments: { get: getAttachmentRemote },
      messages: { get: getMessageRemote },
    } as unknown as AdvancedIMessage;
    const entries = clients(remote);
    const getMessage = def.actions?.getMessage;
    const getAttachment = def.actions?.getAttachment;
    if (!(getMessage && getAttachment)) {
      throw new Error("iMessage resource actions are missing");
    }

    const message = await getMessage(
      { ...ctx, client: entries },
      { ...SPACE, __platform: "iMessage" },
      "p:1/native-parent"
    );
    const attachment = await getAttachment(
      { ...ctx, client: entries },
      "native-attachment",
      PHONE
    );

    expect(message).toMatchObject({
      id: "p:1/native-parent",
      parentId: "native-parent",
      space: { lineId: LINE_ID },
    });
    expect(attachment).toMatchObject({ id: "native-attachment" });
    expect(getMessageRemote).toHaveBeenCalledWith("native-parent");
    expect(getAttachmentRemote).toHaveBeenCalledWith("native-attachment");
  });

  it("updates native mini-app sessions through the selected dedicated line", async () => {
    const session = {
      chatGuid: SPACE.id,
      messageGuid: "native-card",
      sessionId: "session-1",
      targetMessageGuid: "native-target",
    } satisfies MiniAppCardSession;
    const updateCustomizedMiniApp = vi.fn(() =>
      Promise.resolve({
        dateCreated: new Date(0),
        guid: "native-updated",
        miniAppCardSession: session,
      })
    );
    const remote = {
      messages: { updateCustomizedMiniApp },
    } as unknown as AdvancedIMessage;

    await def.send({
      ...ctx,
      client: clients(remote),
      content: {
        content: appContent(),
        target: {
          ...target("native-card"),
          miniAppCardSession: session,
        },
        type: "edit",
      } as never,
      space: SPACE,
    });

    expect(updateCustomizedMiniApp).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ url: "https://example.com/card" })
    );
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
