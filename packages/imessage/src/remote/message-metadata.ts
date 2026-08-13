import type {
  Message as AdvancedIMessageMessage,
  AttachmentInfo,
  MessageAppliedReaction,
  MessageMention,
  MessagePlacedSticker,
  MessageReaction,
  MiniAppContent,
  MiniAppLayoutInfo,
  SingleServiceAddressInfo,
  StickerPlacement,
  TextFormat,
} from "@photon-ai/advanced-imessage/grpc";
import type {
  IMessageAppliedReaction,
  IMessageAttachmentMetadata,
  IMessageMention,
  IMessageMiniAppContent,
  IMessageMiniAppLayoutInfo,
  IMessageNativeMessageMetadata,
  IMessagePlacedSticker,
  IMessageReaction,
  IMessageReactionRecord,
  IMessageStickerPlacement,
  IMessageTextFormat,
} from "../types";

const toTextFormat = (format: TextFormat): IMessageTextFormat => ({
  effectName: format.effectName,
  length: format.length,
  start: format.start,
  type: format.type,
});

const toMention = (mention: MessageMention): IMessageMention => ({
  address: mention.address,
  length: mention.length,
  start: mention.start,
});

const toMiniAppLayout = (
  layout: MiniAppLayoutInfo
): IMessageMiniAppLayoutInfo => ({
  caption: layout.caption,
  imageSubtitle: layout.imageSubtitle,
  imageTitle: layout.imageTitle,
  subcaption: layout.subcaption,
  summary: layout.summary,
  trailingCaption: layout.trailingCaption,
  trailingSubcaption: layout.trailingSubcaption,
});

const toMiniAppContent = (miniApp: MiniAppContent): IMessageMiniAppContent => ({
  appName: miniApp.appName,
  appStoreId: miniApp.appStoreId,
  extensionBundleId: miniApp.extensionBundleId,
  layout: miniApp.layout ? toMiniAppLayout(miniApp.layout) : undefined,
  live: miniApp.live,
  sessionId: miniApp.sessionId,
  teamId: miniApp.teamId,
  url: miniApp.url,
});

const toAttachmentMetadata = (
  attachment: AttachmentInfo
): IMessageAttachmentMetadata => ({
  companionKind: attachment.companionKind,
  fileName: attachment.fileName,
  guid: attachment.guid,
  isHidden: attachment.isHidden,
  isSticker: attachment.isSticker,
  mimeType: attachment.mimeType,
  originalGuid: attachment.originalGuid,
  totalBytes: attachment.totalBytes,
  transferState: attachment.transferState,
  uti: attachment.uti,
});

const toServiceAddress = (
  sender: SingleServiceAddressInfo
): NonNullable<IMessageAppliedReaction["sender"]> => ({
  address: sender.address,
  country: sender.country,
  service: sender.service,
});

const toReaction = (reaction: MessageReaction): IMessageReaction => ({
  emoji: reaction.emoji,
  kind: reaction.kind,
});

const toAppliedReaction = (
  applied: MessageAppliedReaction
): IMessageAppliedReaction => ({
  dateCreated: applied.dateCreated,
  isFromMe: applied.isFromMe,
  messageGuid: applied.messageGuid,
  reaction: toReaction(applied.reaction),
  sender: applied.sender ? toServiceAddress(applied.sender) : undefined,
  targetPartIndex: applied.targetPartIndex,
});

const toStickerPlacement = (
  placement: StickerPlacement
): IMessageStickerPlacement => ({
  rotation: placement.rotation,
  scale: placement.scale,
  width: placement.width,
  x: placement.x,
  y: placement.y,
});

const toPlacedSticker = (
  placed: MessagePlacedSticker
): IMessagePlacedSticker => ({
  dateCreated: placed.dateCreated,
  isFromMe: placed.isFromMe,
  messageGuid: placed.messageGuid,
  placement: placed.placement
    ? toStickerPlacement(placed.placement)
    : undefined,
  sender: placed.sender ? toServiceAddress(placed.sender) : undefined,
  sticker: placed.sticker ? toAttachmentMetadata(placed.sticker) : undefined,
  targetPartIndex: placed.targetPartIndex,
});

const toReactionRecord = (
  message: AdvancedIMessageMessage
): IMessageReactionRecord | undefined => {
  if (!(message.reaction && message.reactionTargetGuid)) {
    return;
  }
  return {
    reaction: toReaction(message.reaction),
    selected: message.reactionSelected,
    targetGuid: message.reactionTargetGuid,
    targetPartIndex: message.reactionTargetPartIndex,
  };
};

/**
 * Copy the curated, developer-actionable subset of an Advanced iMessage
 * message into Spectrum-owned data. Keeping this mapper at the native boundary
 * prevents private Apple fields from leaking through normal messages.
 */
export const toMessageMetadata = (
  native: AdvancedIMessageMessage
): IMessageNativeMessageMetadata => ({
  dateDelivered: native.dateDelivered,
  dateEdited: native.dateEdited,
  dateExpressiveSendPlayed: native.dateExpressiveSendPlayed,
  datePlayed: native.datePlayed,
  dateRead: native.dateRead,
  dateRetracted: native.dateRetracted,

  isSent: native.isSent,
  isDelivered: native.isDelivered,
  isDeliveredQuietly: native.isDeliveredQuietly,
  didNotifyRecipient: native.didNotifyRecipient,
  isDelayed: native.isDelayed,
  sendErrorCode: native.sendErrorCode,

  nativeText: native.content?.text,
  miniApp: native.content?.miniApp
    ? toMiniAppContent(native.content.miniApp)
    : undefined,
  formatting: native.content?.formatting?.map(toTextFormat) ?? [],
  mentions: native.content?.mentions?.map(toMention) ?? [],
  subject: native.subject,
  balloonBundleId: native.content?.balloonBundleId,
  expressiveSendStyleId: native.content?.expressiveSendStyleId,
  attachmentMetadata:
    native.content?.attachments?.map(toAttachmentMetadata) ?? [],

  appliedReactions: native.appliedReactions?.map(toAppliedReaction) ?? [],
  placedStickers: native.placedStickers?.map(toPlacedSticker) ?? [],
  reactionRecord: toReactionRecord(native),

  itemType: native.itemType,
  groupTitle: native.groupTitle,
  partCount: native.partCount,

  isAutoReply: native.isAutoReply,
  isCorrupt: native.isCorrupt,
  isExpirable: native.isExpirable,
  isServiceMessage: native.isServiceMessage,
  isSpam: native.isSpam,
  isSystemMessage: native.isSystemMessage,
});
