import {
  type AdvancedIMessage,
  AuthenticationError,
  ConnectionError,
  createGrpcClient,
  type MessageEvent,
  NotFoundError,
  type Message as SDKMessage,
} from "@photon-ai/advanced-imessage/grpc";
import { type Content, type Message, Spectrum } from "@spectrum-ts/core";
import { asAttachment, asGroup, asText } from "@spectrum-ts/core/authoring";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeManagedProvider,
} from "@spectrum-ts/test-support/platform";
import { describe, expect, it, vi } from "vitest";
import { getMessageCache, MessageCache } from "@/cache";
import { imessage } from "@/index";
import {
  getMessage,
  type ReceivedEvent,
  toInboundMessages,
} from "@/remote/inbound";
import { send } from "@/remote/send";
import { type IMessageMessage, type RemoteClient, SHARED_PHONE } from "@/types";

// Only `createGrpcClient` is replaced, so a real Spectrum can register the
// iMessage provider against a synthetic client without any network access.
vi.mock("@photon-ai/advanced-imessage/grpc", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@photon-ai/advanced-imessage/grpc")
  >()),
  createGrpcClient: vi.fn(),
}));

stubCloud();

const UNROUTED_PHONE_ERROR = /No iMessage client serves phone \+15550000000/;

const CREATED_AT = new Date("2026-02-03T04:05:06.000Z");
const DELIVERED_AT = new Date("2026-02-03T04:05:07.000Z");
const READ_AT = new Date("2026-02-03T04:05:08.000Z");
const ATTACHMENT_PLACEHOLDER = "\uFFFC";

const nativeAttachment = (
  guid = "attachment-guid"
): SDKMessage["content"]["attachments"][number] => ({
  fileName: "photo.png",
  guid,
  isHidden: false,
  isOutgoing: false,
  isSticker: false,
  mimeType: "image/png",
  totalBytes: 256,
  transferState: "transferring",
  uti: "public.png",
});

const nativeMessage = (overrides: Partial<SDKMessage> = {}): SDKMessage => ({
  appliedReactions: [],
  chatGuids: ["iMessage;+;chat-guid"],
  content: {
    attachments: [],
    formatting: [{ length: 5, start: 0, type: "bold" }],
    mentions: [{ address: "+15551230002", length: 7, start: 6 }],
    text: "Hello @Taylor",
  },
  dataDetectorResultsPresent: false,
  dateCreated: CREATED_AT,
  dateDelivered: DELIVERED_AT,
  dateRead: READ_AT,
  didNotifyRecipient: true,
  guid: "message-guid",
  isArchived: false,
  isAudioMessage: false,
  isAutoReply: false,
  isCorrupt: false,
  isDelayed: false,
  isDelivered: true,
  isDeliveredQuietly: false,
  isExpirable: false,
  isForward: false,
  isFromMe: false,
  isSent: true,
  isServiceMessage: false,
  isSpam: false,
  isSystemMessage: false,
  itemType: "normal",
  placedStickers: [],
  sendErrorCode: 0,
  sender: {
    address: "+15551230001",
    country: "US",
    service: "iMessage",
  },
  ...overrides,
});

const receivedEvent = (message: SDKMessage): ReceivedEvent =>
  ({
    chatGuid: "iMessage;+;chat-guid",
    isFromMe: message.isFromMe,
    message,
    occurredAt: CREATED_AT,
    sequence: 1,
    type: "message.received",
  }) as Extract<MessageEvent, { type: "message.received" }>;

const groupOf = (...contents: Content[]): Content =>
  asGroup({
    items: contents.map(
      (content) => ({ content, id: "" }) as unknown as Message
    ),
  });

const PHONE = "+15550000000";
const SPACE = {
  __platform: "imessage",
  id: "iMessage;+;chat-guid",
  phone: PHONE,
  type: "group",
} as const;

const definition = imessage.config({}).__definition;
// Both public read keys must resolve to the one upstream-read function, so
// every stale-cache regression below runs against each of them.
const PUBLIC_READ_ACTIONS = ["getMessage", "getMessageFresh"] as const;
type PublicReadAction = (typeof PUBLIC_READ_ACTIONS)[number];

const readAction = (action: PublicReadAction) => {
  const fn = definition.actions?.[action];
  if (!fn) {
    throw new Error(`iMessage must declare the ${action} action`);
  }
  return fn;
};

const callRead = (
  action: PublicReadAction,
  client: RemoteClient[],
  space: { id: string; phone: string },
  id: string
) =>
  readAction(action)(
    { client, config: {} as never, store: undefined as never },
    { ...SPACE, ...space },
    id
  ) as Promise<IMessageMessage | undefined>;

const multipartMessage = (text: string): SDKMessage =>
  nativeMessage({
    content: {
      attachments: [nativeAttachment()],
      formatting: [],
      mentions: [],
      text: `${text} ${ATTACHMENT_PLACEHOLDER}`,
    },
  });

const prefillMessageCache = async (remote: AdvancedIMessage) => {
  const cache = getMessageCache(remote);
  await toInboundMessages(
    remote,
    cache,
    receivedEvent(multipartMessage("previously visible")),
    PHONE
  );
  return cache;
};

const notFound = () =>
  new NotFoundError("message not found", {
    code: "messageNotFound",
    grpcCode: 5,
    retryable: false,
  });

// What the real advanced-imessage mapper builds for grpc 5 + `x-retryable`:
// a transient failure, not an absence.
const retryableNotFound = () =>
  new NotFoundError("message lookup temporarily unavailable", {
    code: "messageNotFound",
    grpcCode: 5,
    retryable: true,
  });

const remoteWith = (get: (guid: string) => Promise<unknown>) =>
  ({ messages: { get } }) as unknown as AdvancedIMessage;

describe.each(PUBLIC_READ_ACTIONS)("public %s upstream reads", (action) => {
  const publicGetMessage = (remote: AdvancedIMessage, id: string) =>
    callRead(action, [{ client: remote, phone: PHONE }], SPACE, id);

  describe.each([
    "message-guid",
    "p:0/message-guid",
  ])("revalidates cached %s", (id) => {
    it("returns undefined when the remote hides the message", async () => {
      const get = vi.fn().mockRejectedValue(notFound());
      const remote = remoteWith(get);
      const cache = await prefillMessageCache(remote);
      expect(cache.get(id)).toBeDefined();

      await expect(publicGetMessage(remote, id)).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledExactlyOnceWith("message-guid");
    });

    it.each([
      new AuthenticationError("access revoked", {
        code: "unauthorized",
        grpcCode: 7,
        retryable: false,
      }),
      new ConnectionError("access check unavailable", {
        code: "serviceUnavailable",
        grpcCode: 14,
        retryable: true,
      }),
      retryableNotFound(),
    ])("propagates %s without serving cached content", async (error) => {
      const get = vi.fn().mockRejectedValue(error);
      const remote = remoteWith(get);
      const cache = await prefillMessageCache(remote);
      expect(cache.get(id)).toBeDefined();

      await expect(publicGetMessage(remote, id)).rejects.toBe(error);
      expect(get).toHaveBeenCalledExactlyOnceWith("message-guid");
    });

    it("rebuilds allowed messages and refreshes the assembly cache", async () => {
      const updated = multipartMessage("currently visible");
      const get = vi.fn().mockResolvedValue(updated);
      const remote = remoteWith(get);
      const cache = await prefillMessageCache(remote);
      const previous = cache.get(id);
      expect(previous).toBeDefined();

      const result = await publicGetMessage(remote, id);
      expect(get).toHaveBeenCalledExactlyOnceWith("message-guid");
      expect(result).not.toBe(previous);
      expect(result).toMatchObject({ id, nativeText: updated.content.text });
      expect(cache.get(id)).toBe(result);
      expect(cache.get("message-guid")?.nativeText).toBe(updated.content.text);
      expect(cache.get("p:0/message-guid")?.content).toEqual(
        asText("currently visible")
      );
    });
  });

  it("does not return a cached child removed from an allowed parent", async () => {
    const get = vi.fn().mockResolvedValue(nativeMessage());
    const remote = remoteWith(get);
    const cache = await prefillMessageCache(remote);
    expect(cache.get("p:0/message-guid")).toBeDefined();

    await expect(
      publicGetMessage(remote, "p:0/message-guid")
    ).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledExactlyOnceWith("message-guid");
    expect(cache.get("message-guid")?.content).toEqual(asText("Hello @Taylor"));
  });

  it("does not embed a cached reply target hidden by the remote", async () => {
    const hiddenTarget = nativeMessage({
      content: {
        attachments: [],
        formatting: [],
        mentions: [],
        text: "previously visible target",
      },
      guid: "target-guid",
    });
    const reply = nativeMessage({ replyTargetGuid: "target-guid" });
    const get = vi.fn((guid: string) =>
      guid === "target-guid"
        ? Promise.reject(notFound())
        : Promise.resolve(reply)
    );
    const remote = remoteWith(get);
    const cache = getMessageCache(remote);
    await toInboundMessages(remote, cache, receivedEvent(hiddenTarget), PHONE);
    expect(cache.get("target-guid")).toBeDefined();

    const result = await publicGetMessage(remote, "message-guid");
    expect(get).toHaveBeenCalledWith("message-guid");
    expect(get).toHaveBeenCalledWith("target-guid");
    expect(result?.content).toMatchObject({
      target: {
        content: {
          raw: { imessage_type: "reply-target", stub: true },
          type: "custom",
        },
        id: "target-guid",
      },
      type: "reply",
    });
  });

  it("rejects instead of stubbing a reply target whose access is unknown", async () => {
    const unavailable = new ConnectionError("access check unavailable", {
      code: "serviceUnavailable",
      grpcCode: 14,
      retryable: true,
    });
    const reply = nativeMessage({ replyTargetGuid: "target-guid" });
    const get = vi.fn((guid: string) =>
      guid === "target-guid"
        ? Promise.reject(unavailable)
        : Promise.resolve(reply)
    );
    const remote = remoteWith(get);

    await expect(publicGetMessage(remote, "message-guid")).rejects.toBe(
      unavailable
    );
  });

  it.each([
    "message-guid",
    "p:0/message-guid",
  ])("rejects %s with a retryable not-found reply target as-is", async (id) => {
    const transient = retryableNotFound();
    const reply = nativeMessage({ replyTargetGuid: "target-guid" });
    const get = vi.fn((guid: string) =>
      guid === "target-guid"
        ? Promise.reject(transient)
        : Promise.resolve(reply)
    );
    const remote = remoteWith(get);

    await expect(publicGetMessage(remote, id)).rejects.toBe(transient);
    expect(get).toHaveBeenCalledWith("message-guid");
    expect(get).toHaveBeenCalledWith("target-guid");
  });

  it("reads through the single shared-mode client for any space phone", async () => {
    const get = vi.fn().mockResolvedValue(nativeMessage());
    const result = await callRead(
      action,
      [{ client: remoteWith(get), phone: SHARED_PHONE }],
      { id: "any;-;+15551230001", phone: SHARED_PHONE },
      "message-guid"
    );
    expect(get).toHaveBeenCalledExactlyOnceWith("message-guid");
    expect(result).toMatchObject({ id: "message-guid" });
  });

  it("routes dedicated reads to the client that owns space.phone", async () => {
    const otherGet = vi.fn().mockRejectedValue(new Error("wrong line"));
    const ownerGet = vi.fn().mockResolvedValue(nativeMessage());
    const result = await callRead(
      action,
      [
        { client: remoteWith(otherGet), phone: "+15550000001" },
        { client: remoteWith(ownerGet), phone: PHONE },
      ],
      SPACE,
      "message-guid"
    );
    expect(ownerGet).toHaveBeenCalledExactlyOnceWith("message-guid");
    expect(otherGet).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "message-guid" });
  });

  it("rejects instead of reading when no dedicated client owns space.phone", async () => {
    const get = vi.fn();
    await expect(
      callRead(
        action,
        [{ client: remoteWith(get), phone: "+15550000001" }],
        SPACE,
        "message-guid"
      )
    ).rejects.toThrow(UNROUTED_PHONE_ERROR);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("getMessageFresh capability", () => {
  it("is the exact same provider function as getMessage", () => {
    expect(typeof definition.actions?.getMessageFresh).toBe("function");
    expect(definition.actions?.getMessageFresh).toBe(
      definition.actions?.getMessage
    );
  });

  it("is exposed on a real Spectrum runtime and shares space.getMessage's read", async () => {
    const get = vi.fn().mockResolvedValue(nativeMessage());
    vi.mocked(createGrpcClient).mockReturnValue(
      remoteWith(get) as ReturnType<typeof createGrpcClient>
    );
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        imessage.config({
          clients: [{ address: "grpc.invalid:443", phone: PHONE, token: "t" }],
        }),
      ],
    });
    try {
      // The worker's feature detection path: the registered runtime's
      // provider definition, not the always-present platform-wise surface.
      const runtime = app.__internal.platforms.get("imessage");
      const actions = runtime?.definition.actions;
      expect(typeof actions?.getMessageFresh).toBe("function");
      expect(actions?.getMessageFresh).toBe(actions?.getMessage);

      const im = imessage(app);
      const space = await im.space.get(SPACE.id);
      const raw = await im.getMessageFresh(space, "message-guid");
      const wrapped = await space.getMessage("message-guid");

      // Each call reads upstream; nothing is served from the assembly cache.
      expect(get).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenNthCalledWith(1, "message-guid");
      expect(get).toHaveBeenNthCalledWith(2, "message-guid");
      // Instance action: raw provider record. Space sugar: wrapped Message.
      expect(raw).toMatchObject({
        id: "message-guid",
        nativeText: "Hello @Taylor",
        space: { id: SPACE.id },
      });
      expect(raw).not.toHaveProperty("platform");
      expect(wrapped).toMatchObject({
        id: "message-guid",
        nativeText: "Hello @Taylor",
        platform: "imessage",
      });
      expect(wrapped && imessage.is(wrapped)).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it("is absent, not an UnsupportedError stub, on providers that do not declare it", async () => {
    const provider = makeManagedProvider("no_fresh_read");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const runtime = app.__internal.platforms.get("no_fresh_read");
      expect(runtime?.definition.actions?.getMessageFresh).toBeUndefined();
      expect(
        (provider(app) as unknown as Record<string, unknown>).getMessageFresh
      ).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});

describe("curated metadata across native message paths", () => {
  it("includes metadata on ordinary inbound messages without extra RPCs", async () => {
    const get = vi.fn();
    const remote = { messages: { get } } as unknown as AdvancedIMessage;

    const [message] = await toInboundMessages(
      remote,
      new MessageCache(),
      receivedEvent(nativeMessage()),
      "+15550000000"
    );

    expect(get).not.toHaveBeenCalled();
    expect(message).toMatchObject({
      dateDelivered: DELIVERED_AT,
      dateRead: READ_AT,
      formatting: [{ length: 5, start: 0, type: "bold" }],
      isDelivered: true,
      mentions: [{ address: "+15551230002", length: 7, start: 6 }],
      nativeText: "Hello @Taylor",
      sendErrorCode: 0,
    });
  });

  it("includes metadata on getMessage and refetches cached messages", async () => {
    const get = vi.fn(() => Promise.resolve(nativeMessage()));
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;

    const first = await getMessage(
      remote,
      "iMessage;+;chat-guid",
      "message-guid",
      "+15550000000"
    );
    const second = await getMessage(
      remote,
      "iMessage;+;chat-guid",
      "message-guid",
      "+15550000000"
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(first?.dateDelivered).toEqual(DELIVERED_AT);
    expect(first?.nativeText).toBe("Hello @Taylor");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("computes multipart metadata once and carries it to every child", async () => {
    const attachment = nativeAttachment();
    const [parent] = await toInboundMessages(
      { messages: {} } as unknown as AdvancedIMessage,
      new MessageCache(),
      receivedEvent(
        nativeMessage({
          content: {
            attachments: [attachment],
            formatting: [],
            mentions: [],
            text: `before ${ATTACHMENT_PLACEHOLDER} after`,
          },
          partCount: 3,
        })
      ),
      "+15550000000"
    );

    expect(parent?.content.type).toBe("group");
    if (parent?.content.type !== "group") {
      throw new Error("expected multipart group");
    }

    expect(parent.partCount).toBe(3);
    expect(parent.attachmentMetadata).toEqual([
      {
        companionKind: undefined,
        fileName: "photo.png",
        guid: "attachment-guid",
        isHidden: false,
        isSticker: false,
        mimeType: "image/png",
        originalGuid: undefined,
        totalBytes: 256,
        transferState: "transferring",
        uti: "public.png",
      },
    ]);
    for (const [partIndex, item] of parent.content.items.entries()) {
      const child = item as unknown as IMessageMessage;
      expect(child.parentId).toBe("message-guid");
      expect(child.partIndex).toBe(partIndex);
      expect(child.attachmentMetadata).toEqual(parent.attachmentMetadata);
    }
  });

  it("includes metadata on native regular and multipart outbound results", async () => {
    const singleNative = nativeMessage({
      guid: "single-guid",
      isFromMe: true,
    });
    const multipartNative = nativeMessage({
      content: {
        attachments: [nativeAttachment()],
        formatting: [],
        mentions: [],
        text: `hello ${ATTACHMENT_PLACEHOLDER}`,
      },
      guid: "multipart-guid",
      isFromMe: true,
      partCount: 2,
    });
    const sendText = vi.fn(() => Promise.resolve(singleNative));
    const sendMultipart = vi.fn(() => Promise.resolve(multipartNative));
    const upload = vi.fn(() =>
      Promise.resolve({ attachment: { guid: "uploaded-guid" } })
    );
    const remote = {
      attachments: { upload },
      messages: { sendMultipart, sendText },
    } as unknown as AdvancedIMessage;
    const attachment = asAttachment({
      mimeType: "image/png",
      name: "photo.png",
      read: () => Promise.resolve(Buffer.from("photo")),
    });

    const single = (await send(
      remote,
      "iMessage;+;chat-guid",
      asText("Hello")
    )) as IMessageMessage;
    const multipart = (await send(
      remote,
      "iMessage;+;chat-guid",
      groupOf(asText("hello"), attachment)
    )) as IMessageMessage;

    expect(single).toMatchObject({
      dateDelivered: DELIVERED_AT,
      isDelivered: true,
      nativeText: "Hello @Taylor",
      sendErrorCode: 0,
    });
    expect(multipart.partCount).toBe(2);
    expect(multipart.content.type).toBe("group");
    if (multipart.content.type !== "group") {
      throw new Error("expected multipart group");
    }
    for (const item of multipart.content.items) {
      expect((item as unknown as IMessageMessage).attachmentMetadata).toEqual(
        multipart.attachmentMetadata
      );
    }
  });

  it("does not leak an unsupported Advanced message through custom content", async () => {
    const [message] = await toInboundMessages(
      { messages: {} } as unknown as AdvancedIMessage,
      new MessageCache(),
      receivedEvent(
        nativeMessage({
          content: {
            attachments: [],
            formatting: [],
            mentions: [],
            text: undefined,
          },
          itemType: "chatAction",
        })
      ),
      "+15550000000"
    );

    expect(message?.content).toEqual({
      raw: {
        imessage_type: "unsupported-message",
      },
      type: "custom",
    });
    if (message?.content.type !== "custom") {
      throw new Error("expected custom fallback");
    }
    expect(message.itemType).toBe("chatAction");
    expect(message.content.raw).not.toHaveProperty("guid");
    expect(message.content.raw).not.toHaveProperty("content");
    expect(message.content.raw).not.toHaveProperty("chatGuids");
  });
});
