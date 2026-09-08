import type {
  AdvancedIMessage,
  MessageEvent,
  MiniAppContent,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage/grpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageCache } from "@/cache";
import { type ReceivedEvent, toInboundMessages } from "@/remote/inbound";

const CREATED_AT = new Date("2026-02-03T04:05:06.000Z");

// Shape and values taken from a real GamePigeon "Four in a Row" session: a
// move arrives with no text of its own, carrying everything it displays in the
// balloon payload.
const GAME_URL = "https://gamepigeonapp.com/?ver=52&data=oB0cet0ELMle0C23";
const SESSION_ID = "2385D202-E40E-4D47-86F7-E9C3FDE818EA";

const gamePigeon = (
  overrides: Partial<MiniAppContent> = {}
): MiniAppContent => ({
  appName: "GamePigeon",
  extensionBundleId: "com.gamerdelights.gamepigeon.ext",
  layout: { caption: "Your move." },
  live: true,
  sessionId: SESSION_ID,
  teamId: "EWFNLB79LQ",
  url: GAME_URL,
  ...overrides,
});

const nativeMessage = (
  miniApp: MiniAppContent | undefined,
  text?: string
): SDKMessage =>
  ({
    appliedReactions: [],
    chatGuids: ["iMessage;-;+15550000001"],
    content: {
      attachments: [],
      balloonBundleId:
        "com.apple.messages.MSMessageExtensionBalloonPlugin" +
        ":EWFNLB79LQ:com.gamerdelights.gamepigeon.ext",
      formatting: [],
      mentions: [],
      miniApp,
      text,
    },
    dataDetectorResultsPresent: false,
    dateCreated: CREATED_AT,
    didNotifyRecipient: true,
    guid: "gamepigeon-move-1",
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
    sender: { address: "+15550000001", country: "US", service: "iMessage" },
  }) as unknown as SDKMessage;

const inbound = async (miniApp: MiniAppContent | undefined, text?: string) => {
  const [message] = await toInboundMessages(
    { messages: {} } as unknown as AdvancedIMessage,
    new MessageCache(),
    {
      chatGuid: "iMessage;-;+15550000001",
      isFromMe: false,
      message: nativeMessage(miniApp, text),
      occurredAt: CREATED_AT,
      sequence: 1,
      type: "message.received",
    } as Extract<MessageEvent, { type: "message.received" }> as ReceivedEvent,
    "+15550000000"
  );
  if (!message) {
    throw new Error("expected an inbound message");
  }
  return message;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inbound app cards", () => {
  it("maps a third-party app card to app content", async () => {
    const message = await inbound(gamePigeon());

    expect(message.content.type).toBe("app");
    if (message.content.type !== "app") {
      throw new Error("expected app content");
    }
    expect(await message.content.url()).toBe(GAME_URL);
    expect(await message.content.layout()).toEqual({ caption: "Your move." });
    expect(message.content.live).toBe(true);
  });

  it("uses the sender's layout without fetching link metadata", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const message = await inbound(gamePigeon());
    if (message.content.type !== "app") {
      throw new Error("expected app content");
    }
    await message.content.layout();
    await message.content.url();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prefers the card over Apple's fallback text", async () => {
    const message = await inbound(gamePigeon(), "Four in a Row");

    expect(message.content.type).toBe("app");
    expect(message.nativeText).toBe("Four in a Row");
  });

  it("falls back to summary when the card has no caption", async () => {
    const message = await inbound(
      gamePigeon({ layout: { summary: "Your move!" } })
    );

    if (message.content.type !== "app") {
      throw new Error("expected app content");
    }
    expect(await message.content.layout()).toEqual({
      caption: "Your move!",
      summary: "Your move!",
    });
  });

  it("falls back to the app name when the card has no text at all", async () => {
    const message = await inbound(gamePigeon({ layout: undefined }));

    if (message.content.type !== "app") {
      throw new Error("expected app content");
    }
    expect(await message.content.layout()).toEqual({ caption: "GamePigeon" });
  });

  it("drops image slots that would need image bytes the card never carries", async () => {
    const message = await inbound(
      gamePigeon({
        layout: {
          caption: "Your move.",
          imageSubtitle: "tap to play",
          imageTitle: "GamePigeon",
        },
      })
    );

    if (message.content.type !== "app") {
      throw new Error("expected app content");
    }
    expect(await message.content.layout()).toEqual({ caption: "Your move." });
    expect(message.miniApp?.layout).toMatchObject({
      imageSubtitle: "tap to play",
      imageTitle: "GamePigeon",
    });
  });

  it("surfaces the native card details on message metadata", async () => {
    const message = await inbound(gamePigeon());

    expect(message.miniApp).toEqual({
      appName: "GamePigeon",
      appStoreId: undefined,
      extensionBundleId: "com.gamerdelights.gamepigeon.ext",
      layout: {
        caption: "Your move.",
        imageSubtitle: undefined,
        imageTitle: undefined,
        subcaption: undefined,
        summary: undefined,
        trailingCaption: undefined,
        trailingSubcaption: undefined,
      },
      live: true,
      sessionId: SESSION_ID,
      teamId: "EWFNLB79LQ",
      url: GAME_URL,
    });
  });

  it("keeps the unsupported fallback when the card has no url", async () => {
    const message = await inbound(gamePigeon({ url: undefined }));

    expect(message.content).toEqual({
      raw: { imessage_type: "unsupported-message" },
      type: "custom",
    });
  });

  it("keeps the unsupported fallback when the url cannot be parsed", async () => {
    const message = await inbound(gamePigeon({ url: "not a url" }));

    expect(message.content).toEqual({
      raw: { imessage_type: "unsupported-message" },
      type: "custom",
    });
  });

  it("leaves ordinary messages on the text path", async () => {
    const message = await inbound(undefined, "Hello");

    expect(message.content.type).toBe("text");
  });
});
