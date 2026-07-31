import type { Message as AdvancedIMessageMessage } from "@photon-ai/advanced-imessage/grpc";
import type { Message } from "@spectrum-ts/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { imessage } from "@/index";
import { toMessageMetadata } from "@/remote/message-metadata";
import {
  type IMessageMessage,
  messageSchema,
  nativeMessageMetadataSchema,
} from "@/types";

const CREATED_AT = new Date("2026-01-02T03:04:05.000Z");
const DELIVERED_AT = new Date("2026-01-02T03:04:06.000Z");
const READ_AT = new Date("2026-01-02T03:04:07.000Z");
const EDITED_AT = new Date("2026-01-02T03:04:08.000Z");
const PLAYED_AT = new Date("2026-01-02T03:04:09.000Z");
const EXPRESSIVE_PLAYED_AT = new Date("2026-01-02T03:04:10.000Z");
const RETRACTED_AT = new Date("2026-01-02T03:04:11.000Z");

const completeAdvancedMessage = (): AdvancedIMessageMessage => ({
  appliedReactions: [
    {
      dateCreated: CREATED_AT,
      isFromMe: false,
      messageGuid: "reaction-guid",
      reaction: { kind: "emoji", emoji: "🔥" },
      sender: {
        address: "+15551230001",
        country: "US",
        service: "iMessage",
      },
      targetPartIndex: 2,
    },
  ],
  cachedRoomNames: "Stale room name",
  chatActionType: 42,
  chatGuids: ["iMessage;+;chat-guid", "iMessage;+;joined-chat-guid"],
  content: {
    attachments: [
      {
        companionKind: "live-photo-video",
        fileName: "IMG_1000.HEIC",
        guid: "attachment-guid",
        isHidden: false,
        isOutgoing: true,
        isSticker: false,
        mimeType: "image/heic",
        originalGuid: "original-attachment-guid",
        totalBytes: 4096,
        transferState: "failed",
        uti: "public.heic",
      },
    ],
    balloonBundleId: "com.apple.messages.URLBalloonProvider",
    expressiveSendStyleId: "com.apple.messages.effect.CKConfettiEffect",
    formatting: [
      {
        effectName: "big",
        length: 5,
        start: 0,
        type: "bold",
      },
    ],
    mentions: [{ address: "+15551230002", length: 12, start: 6 }],
    text: "Hello @Taylor",
  },
  dataDetectorResultsPresent: true,
  dateCreated: CREATED_AT,
  dateDelivered: DELIVERED_AT,
  dateEdited: EDITED_AT,
  dateExpressiveSendPlayed: EXPRESSIVE_PLAYED_AT,
  datePlayed: PLAYED_AT,
  dateRead: READ_AT,
  dateRetracted: RETRACTED_AT,
  destinationCallerId: "P:+15550000000",
  didNotifyRecipient: false,
  groupTitle: "Current title",
  guid: "message-guid",
  isArchived: true,
  isAudioMessage: false,
  isAutoReply: true,
  isCorrupt: false,
  isDelayed: true,
  isDelivered: true,
  isDeliveredQuietly: true,
  isExpirable: true,
  isForward: true,
  isFromMe: true,
  isSent: true,
  isServiceMessage: false,
  isSpam: true,
  isSystemMessage: false,
  itemType: "participantChange",
  partCount: 3,
  placedStickers: [
    {
      dateCreated: CREATED_AT,
      isFromMe: true,
      messageGuid: "sticker-message-guid",
      placement: {
        rotation: 0.25,
        scale: 1.5,
        width: 120,
        x: 0.4,
        y: 0.7,
      },
      sender: {
        address: "+15551230003",
        service: "SMS",
      },
      sticker: {
        fileName: "sticker.heic",
        guid: "sticker-guid",
        isHidden: true,
        isOutgoing: true,
        isSticker: true,
        mimeType: "image/heic",
        totalBytes: 512,
        transferState: "finished",
        uti: "com.apple.sticker",
      },
      targetPartIndex: 1,
    },
  ],
  reaction: { kind: "like" },
  reactionSelected: true,
  reactionTargetGuid: "reaction-target-guid",
  reactionTargetPartIndex: 4,
  replyTargetGuid: "reply-target-guid",
  sendErrorCode: 17,
  sender: {
    address: "+15551230004",
    country: "US",
    service: "iMessage",
  },
  shareDirection: 1,
  shareStatus: 2,
  subject: "Native subject",
  threadOriginatorGuid: "thread-originator-guid",
  threadOriginatorPart: "0:0/0",
});

const advancedMessageFieldPolicy = {
  appliedReactions: "expose",
  cachedRoomNames: "omit",
  chatActionType: "omit",
  chatGuids: "omit",
  content: "transform",
  dataDetectorResultsPresent: "omit",
  dateCreated: "omit",
  dateDelivered: "expose",
  dateEdited: "expose",
  dateExpressiveSendPlayed: "expose",
  datePlayed: "expose",
  dateRead: "expose",
  dateRetracted: "expose",
  destinationCallerId: "omit",
  didNotifyRecipient: "expose",
  groupTitle: "expose",
  guid: "omit",
  isArchived: "omit",
  isAudioMessage: "omit",
  isAutoReply: "expose",
  isCorrupt: "expose",
  isDelayed: "expose",
  isDelivered: "expose",
  isDeliveredQuietly: "expose",
  isExpirable: "expose",
  isForward: "omit",
  isFromMe: "omit",
  isSent: "expose",
  isServiceMessage: "expose",
  isSpam: "expose",
  isSystemMessage: "expose",
  itemType: "expose",
  partCount: "expose",
  placedStickers: "expose",
  reaction: "transform",
  reactionSelected: "transform",
  reactionTargetGuid: "transform",
  reactionTargetPartIndex: "transform",
  replyTargetGuid: "omit",
  sendErrorCode: "expose",
  sender: "omit",
  shareDirection: "omit",
  shareStatus: "omit",
  subject: "expose",
  threadOriginatorGuid: "omit",
  threadOriginatorPart: "omit",
} as const satisfies Record<
  keyof AdvancedIMessageMessage,
  "expose" | "transform" | "omit"
>;

describe("curated Advanced iMessage metadata", () => {
  it("maps delivery and lifecycle diagnostics", () => {
    const metadata = toMessageMetadata(completeAdvancedMessage());

    expect(metadata).toMatchObject({
      dateDelivered: DELIVERED_AT,
      dateEdited: EDITED_AT,
      dateExpressiveSendPlayed: EXPRESSIVE_PLAYED_AT,
      datePlayed: PLAYED_AT,
      dateRead: READ_AT,
      dateRetracted: RETRACTED_AT,
      didNotifyRecipient: false,
      isDelayed: true,
      isDelivered: true,
      isDeliveredQuietly: true,
      isSent: true,
      sendErrorCode: 17,
    });
  });

  it("maps native text, formatting, mentions, subjects, and effects", () => {
    const metadata = toMessageMetadata(completeAdvancedMessage());

    expect(metadata).toMatchObject({
      balloonBundleId: "com.apple.messages.URLBalloonProvider",
      expressiveSendStyleId: "com.apple.messages.effect.CKConfettiEffect",
      formatting: [
        {
          effectName: "big",
          length: 5,
          start: 0,
          type: "bold",
        },
      ],
      mentions: [{ address: "+15551230002", length: 12, start: 6 }],
      nativeText: "Hello @Taylor",
      subject: "Native subject",
    });
  });

  it("maps actionable attachment transfer metadata without direction", () => {
    const [attachment] = toMessageMetadata(
      completeAdvancedMessage()
    ).attachmentMetadata;

    expect(attachment).toEqual({
      companionKind: "live-photo-video",
      fileName: "IMG_1000.HEIC",
      guid: "attachment-guid",
      isHidden: false,
      isSticker: false,
      mimeType: "image/heic",
      originalGuid: "original-attachment-guid",
      totalBytes: 4096,
      transferState: "failed",
      uti: "public.heic",
    });
    expect(attachment).not.toHaveProperty("isOutgoing");
  });

  it("maps aggregated reactions, placed stickers, and tapback rows", () => {
    const metadata = toMessageMetadata(completeAdvancedMessage());

    expect(metadata.appliedReactions).toEqual([
      {
        dateCreated: CREATED_AT,
        isFromMe: false,
        messageGuid: "reaction-guid",
        reaction: { emoji: "🔥", kind: "emoji" },
        sender: {
          address: "+15551230001",
          country: "US",
          service: "iMessage",
        },
        targetPartIndex: 2,
      },
    ]);
    expect(metadata.placedStickers).toEqual([
      {
        dateCreated: CREATED_AT,
        isFromMe: true,
        messageGuid: "sticker-message-guid",
        placement: {
          rotation: 0.25,
          scale: 1.5,
          width: 120,
          x: 0.4,
          y: 0.7,
        },
        sender: {
          address: "+15551230003",
          country: undefined,
          service: "SMS",
        },
        sticker: {
          companionKind: undefined,
          fileName: "sticker.heic",
          guid: "sticker-guid",
          isHidden: true,
          isSticker: true,
          mimeType: "image/heic",
          originalGuid: undefined,
          totalBytes: 512,
          transferState: "finished",
          uti: "com.apple.sticker",
        },
        targetPartIndex: 1,
      },
    ]);
    expect(metadata.reactionRecord).toEqual({
      reaction: { emoji: undefined, kind: "like" },
      selected: true,
      targetGuid: "reaction-target-guid",
      targetPartIndex: 4,
    });
  });

  it("maps classification and multipart state", () => {
    expect(toMessageMetadata(completeAdvancedMessage())).toMatchObject({
      groupTitle: "Current title",
      isAutoReply: true,
      isCorrupt: false,
      isExpirable: true,
      isServiceMessage: false,
      isSpam: true,
      isSystemMessage: false,
      itemType: "participantChange",
      partCount: 3,
    });
  });

  it("does not expose excluded native row fields", () => {
    const metadata = toMessageMetadata(completeAdvancedMessage());
    const omittedFields = Object.entries(advancedMessageFieldPolicy)
      .filter(([, policy]) => policy === "omit")
      .map(([field]) => field);

    for (const field of omittedFields) {
      expect(metadata).not.toHaveProperty(field);
    }
    expect(metadata).not.toHaveProperty("content");
  });

  it("parses complete native metadata and metadata-free synthetic records", () => {
    const metadata = toMessageMetadata(completeAdvancedMessage());

    expect(nativeMessageMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      messageSchema.parse({
        miniAppCardSession: {
          chatGuid: "chat-guid",
          messageGuid: "message-guid",
          sessionId: "session-id",
          targetMessageGuid: "target-message-guid",
        },
        parentId: "parent-guid",
        partIndex: 0,
      })
    ).toEqual({
      miniAppCardSession: {
        chatGuid: "chat-guid",
        messageGuid: "message-guid",
        sessionId: "session-id",
        targetMessageGuid: "target-message-guid",
      },
      parentId: "parent-guid",
      partIndex: 0,
    });
  });

  it("keeps metadata platform-specific until imessage.is narrows a message", () => {
    type GenericHasDeliveryMetadata = "dateDelivered" extends keyof Message
      ? true
      : false;

    expectTypeOf<GenericHasDeliveryMetadata>().toEqualTypeOf<false>();

    const assertNarrowedMetadata = (message: Message): void => {
      if (imessage.is(message)) {
        expectTypeOf(message.dateDelivered).toEqualTypeOf<Date | undefined>();
        expectTypeOf(message.attachmentMetadata).toEqualTypeOf<
          IMessageMessage["attachmentMetadata"]
        >();
      }

      const narrowed = imessage(message);
      expectTypeOf(narrowed.dateDelivered).toEqualTypeOf<Date | undefined>();
    };

    expectTypeOf(assertNarrowedMetadata).toBeFunction();
  });
});
