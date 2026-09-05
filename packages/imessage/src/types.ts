import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import type { SchemaMessage } from "@spectrum-ts/core";
import z from "zod";

export interface RemoteClient {
  client: AdvancedIMessage;
  phone: string;
}

export type IMessageClient = RemoteClient[];

/**
 * Sentinel phone for shared-token mode. The single shared client serves an
 * unknown set of numbers (the SDK exposes no recipient field on inbound and
 * no `from` parameter on send), so all routing through it tags this sentinel.
 */
export const SHARED_PHONE = "shared";

const clientEntry = z.object({
  address: z.string(),
  token: z.string(),
  phone: z.string(),
});

export const configSchema = z.strictObject({
  clients: clientEntry.or(z.array(clientEntry)).optional(),
});

/**
 * iMessage sender identity. `id` is the cross-provider key (the address);
 * `address`/`country`/`service` mirror the SDK's `SingleServiceAddressInfo`,
 * letting apps tell iMessage from SMS/RCS. All optional because actor-less
 * events cannot always supply them.
 */
const SERVICE_VALUES = ["iMessage", "SMS", "RCS", "unknown"] as const;

export const userSchema = z.object({
  address: z.string().optional(),
  country: z.string().optional(),
  service: z.enum(SERVICE_VALUES).optional(),
});

export const spaceSchema = z.object({
  id: z.string(),
  type: z.enum(["dm", "group"]),
  phone: z.string(),
});

export const spaceParamsSchema = z.object({
  phone: z.string().optional(),
});

const miniAppCardSessionSchema = z.object({
  chatGuid: z.string(),
  messageGuid: z.string(),
  sessionId: z.string(),
  targetMessageGuid: z.string(),
});

const miniAppLayoutInfoSchema = z
  .object({
    caption: z.string().optional(),
    imageSubtitle: z.string().optional(),
    imageTitle: z.string().optional(),
    subcaption: z.string().optional(),
    summary: z.string().optional(),
    trailingCaption: z.string().optional(),
    trailingSubcaption: z.string().optional(),
  })
  .readonly();

const miniAppContentSchema = z
  .object({
    appName: z.string().optional(),
    appStoreId: z.number().int().positive().optional(),
    extensionBundleId: z.string(),
    layout: miniAppLayoutInfoSchema.optional(),
    live: z.boolean(),
    sessionId: z.string().optional(),
    teamId: z.string(),
    url: z.url().optional(),
  })
  .readonly();

const textFormatSchema = z
  .object({
    effectName: z.string().optional(),
    length: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    type: z.string(),
  })
  .readonly();

const mentionSchema = z
  .object({
    address: z.string(),
    length: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
  })
  .readonly();

const attachmentMetadataSchema = z
  .object({
    companionKind: z.enum(["live-photo-video", "unknown"]).optional(),
    fileName: z.string(),
    guid: z.string(),
    isHidden: z.boolean(),
    isSticker: z.boolean(),
    mimeType: z.string(),
    originalGuid: z.string().optional(),
    totalBytes: z.number().nonnegative(),
    transferState: z.enum([
      "pending",
      "transferring",
      "failed",
      "finished",
      "unknown",
    ]),
    uti: z.string(),
  })
  .readonly();

const serviceAddressSchema = z
  .object({
    address: z.string(),
    country: z.string().optional(),
    service: z.enum(SERVICE_VALUES),
  })
  .readonly();

const reactionSchema = z
  .object({
    emoji: z.string().optional(),
    kind: z.enum([
      "love",
      "like",
      "dislike",
      "laugh",
      "emphasize",
      "question",
      "emoji",
      "sticker",
      "unknown",
    ]),
  })
  .readonly();

const appliedReactionSchema = z
  .object({
    dateCreated: z.date(),
    isFromMe: z.boolean(),
    messageGuid: z.string(),
    reaction: reactionSchema,
    sender: serviceAddressSchema.optional(),
    targetPartIndex: z.number().int().nonnegative().optional(),
  })
  .readonly();

const stickerPlacementSchema = z
  .object({
    rotation: z.number().optional(),
    scale: z.number().optional(),
    width: z.number().nonnegative().optional(),
    x: z.number(),
    y: z.number(),
  })
  .readonly();

const placedStickerSchema = z
  .object({
    dateCreated: z.date(),
    isFromMe: z.boolean(),
    messageGuid: z.string(),
    placement: stickerPlacementSchema.optional(),
    sender: serviceAddressSchema.optional(),
    sticker: attachmentMetadataSchema.optional(),
    targetPartIndex: z.number().int().nonnegative().optional(),
  })
  .readonly();

const reactionRecordSchema = z
  .object({
    reaction: reactionSchema,
    selected: z.boolean().optional(),
    targetGuid: z.string(),
    targetPartIndex: z.number().int().nonnegative().optional(),
  })
  .readonly();

export const nativeMessageMetadataSchema = z.object({
  dateDelivered: z.date().optional(),
  dateEdited: z.date().optional(),
  dateExpressiveSendPlayed: z.date().optional(),
  datePlayed: z.date().optional(),
  dateRead: z.date().optional(),
  dateRetracted: z.date().optional(),

  isSent: z.boolean(),
  isDelivered: z.boolean(),
  isDeliveredQuietly: z.boolean(),
  didNotifyRecipient: z.boolean(),
  isDelayed: z.boolean(),
  sendErrorCode: z.number().int(),

  nativeText: z.string().optional(),
  miniApp: miniAppContentSchema.optional(),
  formatting: z.array(textFormatSchema).readonly(),
  mentions: z.array(mentionSchema).readonly(),
  subject: z.string().optional(),
  balloonBundleId: z.string().optional(),
  expressiveSendStyleId: z.string().optional(),
  attachmentMetadata: z.array(attachmentMetadataSchema).readonly(),

  appliedReactions: z.array(appliedReactionSchema).readonly(),
  placedStickers: z.array(placedStickerSchema).readonly(),
  reactionRecord: reactionRecordSchema.optional(),

  itemType: z.enum([
    "normal",
    "groupNameChange",
    "participantChange",
    "chatAction",
    "unknown",
  ]),
  groupTitle: z.string().optional(),
  partCount: z.number().int().nonnegative().optional(),

  isAutoReply: z.boolean(),
  isCorrupt: z.boolean(),
  isExpirable: z.boolean(),
  isServiceMessage: z.boolean(),
  isSpam: z.boolean(),
  isSystemMessage: z.boolean(),
});

/**
 * iMessage-specific per-message metadata surfaced on `IMessageMessage`.
 * Native metadata is optional because synthetic event records do not carry a
 * complete Advanced iMessage message.
 *
 * - `partIndex`: ordered part index within a multi-part message. Text and
 *   attachment parts both consume an index (0 for bare or single-part
 *   messages; 0..N-1 for a group's sub-items).
 * - `parentId`: guid of the parent message for a group sub-item. Undefined
 *   when the message itself is the parent.
 * - `miniAppCardSession`: stable handle returned by mini-app card sends and
 *   updates. It is required to update the card in place later.
 */
export const messageSchema = nativeMessageMetadataSchema.partial().extend({
  miniAppCardSession: miniAppCardSessionSchema.optional(),
  partIndex: z.number().int().nonnegative().optional(),
  parentId: z.string().optional(),
});

export type IMessageAppliedReaction = z.infer<typeof appliedReactionSchema>;
export type IMessageAttachmentMetadata = z.infer<
  typeof attachmentMetadataSchema
>;
export type IMessageMention = z.infer<typeof mentionSchema>;
export type IMessageMiniAppContent = z.infer<typeof miniAppContentSchema>;
export type IMessageMiniAppLayoutInfo = z.infer<typeof miniAppLayoutInfoSchema>;
export type IMessageNativeMessageMetadata = z.infer<
  typeof nativeMessageMetadataSchema
>;
export type IMessagePlacedSticker = z.infer<typeof placedStickerSchema>;
export type IMessageReaction = z.infer<typeof reactionSchema>;
export type IMessageReactionRecord = z.infer<typeof reactionRecordSchema>;
export type IMessageStickerPlacement = z.infer<typeof stickerPlacementSchema>;
export type IMessageTextFormat = z.infer<typeof textFormatSchema>;

export type IMessageMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
> &
  z.infer<typeof messageSchema> & {
    direction?: "inbound" | "outbound";
  };
