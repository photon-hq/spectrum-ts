import z from "zod";
import type { SchemaMessage } from "../../platform/types";

export const parseModeSchema = z
  .enum(["MarkdownV2", "HTML", "Markdown"])
  .optional();

export type ParseMode = z.infer<typeof parseModeSchema>;

export const webhookConfigSchema = z
  .object({
    url: z.string().url(),
    port: z.number().int().positive().optional(),
    secretToken: z.string().optional(),
  })
  .optional();

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

export const configSchema = z.object({
  token: z.string().min(1),
  paymentProviderToken: z.string().optional(),
  parseMode: parseModeSchema,
  logLevel: z
    .enum(["silent", "error", "warn", "info", "debug"])
    .optional()
    .default("error"),
  webhook: webhookConfigSchema,
});

export const spaceSchema = z.object({
  id: z.string(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
});

export type TelegramMessage = SchemaMessage<undefined, typeof spaceSchema>;

export interface EditedMessage {
  content: import("../../content/types").Content;
  editDate: Date;
  id: string;
  sender: { id: string };
  space: { id: string; type: string };
}

export interface ChannelPost {
  content: import("../../content/types").Content;
  id: string;
  space: { id: string; type: "channel" };
  timestamp: Date;
}

export interface CallbackQuery {
  data?: string;
  id: string;
  messageId?: string;
  sender: { id: string };
  space?: { id: string; type: string };
}

export interface ShippingQueryEvent {
  id: string;
  invoicePayload: string;
  sender: { id: string };
  shippingAddress: {
    countryCode: string;
    state: string;
    city: string;
    streetLine1: string;
    streetLine2: string;
    postCode: string;
  };
}

export interface PreCheckoutQueryEvent {
  currency: string;
  id: string;
  invoicePayload: string;
  sender: { id: string };
  totalAmount: number;
}

export interface SuccessfulPaymentEvent {
  currency: string;
  invoicePayload: string;
  sender: { id: string };
  space: { id: string; type: string };
  totalAmount: number;
}

export interface LabeledPrice {
  amount: number;
  label: string;
}

export interface InvoiceParams {
  currency: string;
  description: string;
  isFlexible?: boolean;
  maxTipAmount?: number;
  needEmail?: boolean;
  needName?: boolean;
  needPhoneNumber?: boolean;
  needShippingAddress?: boolean;
  payload: string;
  photoHeight?: number;
  photoSize?: number;
  photoUrl?: string;
  photoWidth?: number;
  prices: LabeledPrice[];
  providerData?: string;
  providerToken?: string;
  sendEmailToProvider?: boolean;
  sendPhoneNumberToProvider?: boolean;
  startParameter?: string;
  suggestedTipAmounts?: number[];
  title: string;
}

export interface ShippingOption {
  id: string;
  prices: LabeledPrice[];
  title: string;
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface ChatInfo {
  description?: string;
  firstName?: string;
  id: string;
  lastName?: string;
  memberCount?: number;
  title?: string;
  type: string;
  username?: string;
}

export interface ChatMemberInfo {
  customTitle?: string;
  isAnonymous?: boolean;
  status: string;
  userId: string;
}

export interface BusinessRights {
  canDeleteAllMessages?: boolean;
  canDeleteOutgoingMessages?: boolean;
  canEditBio?: boolean;
  canEditName?: boolean;
  canEditProfilePhoto?: boolean;
  canEditUsername?: boolean;
  canReadMessages?: boolean;
  canReply?: boolean;
}

export interface BusinessConnectionEvent {
  date: Date;
  id: string;
  isEnabled: boolean;
  rights?: BusinessRights;
  userChatId: string;
  userId: string;
}

export interface BusinessMessageEvent {
  businessConnectionId: string;
  content: import("../../content/types").Content;
  id: string;
  sender: { id: string };
  space: { id: string; type: string };
  timestamp: Date;
}

export interface DeletedBusinessMessagesEvent {
  businessConnectionId: string;
  messageIds: string[];
  space: { id: string; type: string };
}

export interface PaidMediaParams {
  caption?: string;
  media: { data: Buffer | string; type: "photo" | "video" }[];
  parseMode?: ParseMode;
  payload?: string;
  starCount: number;
}

export interface CreateInvoiceLinkParams {
  currency: string;
  description: string;
  maxTipAmount?: number;
  payload: string;
  photoHeight?: number;
  photoSize?: number;
  photoUrl?: string;
  photoWidth?: number;
  prices: LabeledPrice[];
  providerData?: string;
  providerToken?: string;
  subscriptionPeriod?: number;
  suggestedTipAmounts?: number[];
  title: string;
}

// ---------------------------------------------------------------------------
// Chat management
// ---------------------------------------------------------------------------

export interface ChatPermissions {
  canAddWebPagePreviews?: boolean;
  canChangeInfo?: boolean;
  canInviteUsers?: boolean;
  canManageTopics?: boolean;
  canPinMessages?: boolean;
  canSendAudios?: boolean;
  canSendDocuments?: boolean;
  canSendMessages?: boolean;
  canSendOther?: boolean;
  canSendPhotos?: boolean;
  canSendPolls?: boolean;
  canSendVideoNotes?: boolean;
  canSendVideos?: boolean;
  canSendVoiceNotes?: boolean;
}

export interface ChatAdminInfo {
  canBeEdited?: boolean;
  canDeleteMessages?: boolean;
  canManageChat?: boolean;
  customTitle?: string;
  isAnonymous?: boolean;
  status: "creator" | "administrator";
  userId: string;
  username?: string;
}

export interface ChatInviteLinkInfo {
  createsJoinRequest?: boolean;
  expireDate?: Date;
  inviteLink: string;
  isPrimary?: boolean;
  isRevoked?: boolean;
  memberLimit?: number;
  name?: string;
  pendingJoinRequestCount?: number;
}

export interface CreateInviteLinkOptions {
  createsJoinRequest?: boolean;
  expireDate?: number;
  memberLimit?: number;
  name?: string;
}

// ---------------------------------------------------------------------------
// Forum topics
// ---------------------------------------------------------------------------

export interface ForumTopicInfo {
  iconColor?: number;
  iconCustomEmojiId?: string;
  messageThreadId: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export interface PollOption {
  text: string;
  voterCount?: number;
}

export interface SendPollParams {
  allowsMultipleAnswers?: boolean;
  closeDate?: number;
  correctOptionId?: number;
  explanation?: string;
  isAnonymous?: boolean;
  isClosed?: boolean;
  openPeriod?: number;
  options: string[];
  question: string;
  type?: "regular" | "quiz";
}

export interface PollInfo {
  id: string;
  isClosed: boolean;
  options: PollOption[];
  question: string;
  totalVoterCount: number;
  type: string;
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export interface SendLocationParams {
  heading?: number;
  horizontalAccuracy?: number;
  latitude: number;
  livePeriod?: number;
  longitude: number;
  proximityAlertRadius?: number;
}

// ---------------------------------------------------------------------------
// Event types: reactions, join requests, member updates, boosts, poll answers
// ---------------------------------------------------------------------------

export interface MessageReactionEvent {
  actorId: string;
  date: Date;
  messageId: string;
  newReactions: { emoji?: string; customEmojiId?: string; type: string }[];
  oldReactions: { emoji?: string; customEmojiId?: string; type: string }[];
  space: { id: string; type: string };
}

export interface ChatJoinRequestEvent {
  bio?: string;
  date: Date;
  inviteLink?: string;
  space: { id: string; type: string };
  userId: string;
}

export interface ChatMemberUpdateEvent {
  date: Date;
  newStatus: string;
  oldStatus: string;
  space: { id: string; type: string };
  userId: string;
}

export interface ChatBoostEvent {
  boostId: string;
  date: Date;
  expirationDate: Date;
  source: string;
  space: { id: string; type: string };
}

export interface ChatBoostRemovedEvent {
  boostId: string;
  removeDate: Date;
  source: string;
  space: { id: string; type: string };
}

export interface PollAnswerEvent {
  optionIds: number[];
  pollId: string;
  userId: string;
}

export interface PurchasedPaidMediaEvent {
  payload: string;
  space: { id: string; type: string };
  userId: string;
}

// ---------------------------------------------------------------------------
// Stars & monetization
// ---------------------------------------------------------------------------

export interface StarTransaction {
  amount: number;
  date: Date;
  id: string;
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export interface StoryInfo {
  id: number;
}

// ---------------------------------------------------------------------------
// Business account management
// ---------------------------------------------------------------------------

export interface BusinessStarBalance {
  amount: number;
}

// ---------------------------------------------------------------------------
// Media groups
// ---------------------------------------------------------------------------

export interface MediaGroupItem {
  caption?: string;
  data: Buffer | string;
  parseMode?: ParseMode;
  type: "audio" | "document" | "photo" | "video";
}

// ---------------------------------------------------------------------------
// Story content
// ---------------------------------------------------------------------------

export interface PostStoryParams {
  activePeriod: number;
  caption?: string;
  data: Buffer | string;
  parseMode?: ParseMode;
  type: "photo" | "video";
}

// ---------------------------------------------------------------------------
// Edit invite link options
// ---------------------------------------------------------------------------

export interface EditInviteLinkOptions {
  createsJoinRequest?: boolean;
  expireDate?: number;
  memberLimit?: number;
  name?: string;
}

// ---------------------------------------------------------------------------
// Bot identity
// ---------------------------------------------------------------------------

export interface BotInfo {
  canJoinGroups: boolean;
  canManageBots: boolean;
  canReadAllGroupMessages: boolean;
  firstName: string;
  id: number;
  isBot: true;
  supportsInlineQueries: boolean;
  username: string;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface WebhookInfo {
  hasCustomCertificate: boolean;
  ipAddress?: string;
  lastErrorDate?: Date;
  lastErrorMessage?: string;
  lastSynchronizationErrorDate?: Date;
  maxConnections?: number;
  pendingUpdateCount: number;
  url?: string;
}

// ---------------------------------------------------------------------------
// Default administrator rights
// ---------------------------------------------------------------------------

export interface AdminRights {
  canChangeInfo: boolean;
  canDeleteMessages: boolean;
  canDeleteStories: boolean;
  canEditMessages?: boolean;
  canEditStories: boolean;
  canInviteUsers: boolean;
  canManageChat: boolean;
  canManageTags?: boolean;
  canManageVideoChats: boolean;
  canPinMessages?: boolean;
  canPostMessages?: boolean;
  canPostStories: boolean;
  canPromoteMembers: boolean;
  canRestrictMembers: boolean;
  isAnonymous: boolean;
}

// ---------------------------------------------------------------------------
// User chat boosts
// ---------------------------------------------------------------------------

export interface UserChatBoost {
  addDate: Date;
  boostId: string;
  expirationDate: Date;
  source: string;
}

// ---------------------------------------------------------------------------
// Gifts
// ---------------------------------------------------------------------------

export interface GiftItem {
  id: string;
  remainingCount?: number;
  starCount?: number;
  totalCount?: number;
}

export interface OwnedGiftItem {
  giftId: string;
  ownedGiftId?: string;
  senderId?: string;
  sentDate?: Date;
}

export interface AcceptedGiftTypesConfig {
  giftsFromChannels: boolean;
  limitedGifts: boolean;
  premiumSubscription: boolean;
  uniqueGifts: boolean;
  unlimitedGifts: boolean;
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export interface ChecklistTask {
  id: number;
  parseMode?: ParseMode;
  text: string;
}

export interface ChecklistParams {
  othersCanAddTasks?: boolean;
  othersCanMarkTasksAsDone?: boolean;
  parseMode?: ParseMode;
  tasks: ChecklistTask[];
  title: string;
}

// ---------------------------------------------------------------------------
// Menu button
// ---------------------------------------------------------------------------

export interface MenuButtonResult {
  text?: string;
  type: "commands" | "default" | "web_app";
  webAppUrl?: string;
}

// ---------------------------------------------------------------------------
// Suggested posts
// ---------------------------------------------------------------------------

export interface SuggestedPostOptions {
  scheduledDate?: number;
}

// ---------------------------------------------------------------------------
// Profile photo
// ---------------------------------------------------------------------------

export interface ProfilePhotoParams {
  data: Buffer | string;
  mainFrameTimestamp?: number;
  type: "animated" | "static";
}

// ---------------------------------------------------------------------------
// Stickers
// ---------------------------------------------------------------------------

export type StickerFormat = "animated" | "static" | "video";
export type StickerType = "custom_emoji" | "mask" | "regular";

export interface MaskPositionParams {
  point: "chin" | "eyes" | "forehead" | "mouth";
  scale: number;
  xShift: number;
  yShift: number;
}

export interface InputStickerParams {
  emojiList: string[];
  format: StickerFormat;
  keywords?: string[];
  maskPosition?: MaskPositionParams;
  sticker: Buffer | string;
}

export interface StickerInfo {
  customEmojiId?: string;
  emoji?: string;
  fileId: string;
  fileUniqueId: string;
  height: number;
  isAnimated: boolean;
  isVideo: boolean;
  setName?: string;
  type: StickerType;
  width: number;
}

export interface StickerSetInfo {
  name: string;
  stickers: StickerInfo[];
  stickerType: StickerType;
  title: string;
}
