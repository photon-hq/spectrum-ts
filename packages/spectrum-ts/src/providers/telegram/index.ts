// ---------------------------------------------------------------------------
// Upcoming / Future Integration Areas
// ---------------------------------------------------------------------------
// Mini Apps (Web Apps)
//   Full client-side JS SDK for building embedded interfaces inside Telegram.
//   Requires: WebApp init, theme params, viewport events, haptic feedback,
//   cloud storage, biometrics, QR scanning, full-screen mode, home screen
//   shortcuts, device motion, geolocation, secure storage, share to stories.
//   See: https://core.telegram.org/bots/webapps
//
// Managed Bots
//   getManagedBotToken, replaceManagedBotToken, savePreparedKeyboardButton.
//   See: https://core.telegram.org/bots/features#managed-bots
//
// Verification
//   verifyChat, verifyUser, removeChatVerification, removeUserVerification.
//   Requires special Telegram approval.
//
// Passport
//   setPassportDataErrors - for Telegram Passport data validation.
//   See: https://core.telegram.org/passport
//
// sendMessageDraft (streaming text)
//   Real-time token-by-token message streaming for AI chatbots.
//   Requires PlatformDef streaming support.
// ---------------------------------------------------------------------------

import type { InlineKeyboardMarkup, InlineQueryResult } from "@grammyjs/types";
import { Bot } from "grammy";
import type { Content } from "../../content/types";
import { definePlatform } from "../../platform/define";
import { type ManagedStream, stream } from "../../utils/stream";
import { createLogger, type TelegramLogger } from "./errors";
import {
  addStickerToSet,
  answerCallbackQuery,
  answerInlineQuery,
  answerPreCheckoutQuery,
  answerShippingQuery,
  answerWebAppQuery,
  approveChatJoinRequest,
  approveSuggestedPost,
  banChatMember,
  banChatSenderChat,
  botClose,
  botLogOut,
  businessSend,
  closeForumTopic,
  closeGeneralForumTopic,
  convertGiftToStars,
  copyMessage,
  copyMessages,
  createChatInviteLink,
  createChatSubscriptionInviteLink,
  createForumTopic,
  createInvoiceLink,
  createNewStickerSet,
  declineChatJoinRequest,
  declineSuggestedPost,
  deleteBusinessMessages,
  deleteChatPhoto,
  deleteChatStickerSet,
  deleteForumTopic,
  deleteMessage,
  deleteMessages,
  deleteMyCommands,
  deleteStickerFromSet,
  deleteStickerSet,
  deleteStory,
  deleteWebhookApi,
  editChatInviteLink,
  editChatSubscriptionInviteLink,
  editForumTopic,
  editGeneralForumTopic,
  editMessage,
  editMessageCaption,
  editMessageCaptionInline,
  editMessageChecklist,
  editMessageLiveLocation,
  editMessageLiveLocationInline,
  editMessageReplyMarkup,
  editMessageReplyMarkupInline,
  editMessageTextInline,
  editStory,
  editUserStarSubscription,
  exportChatInviteLink,
  forwardMessage,
  forwardMessages,
  getAvailableGifts,
  getBusinessAccountGifts,
  getBusinessAccountStarBalance,
  getBusinessConnection,
  getChatAdministrators,
  getChatGifts,
  getChatInfo,
  getChatMember,
  getChatMemberCount,
  getChatMenuButton as getChatMenuButtonFn,
  getCustomEmojiStickers,
  getForumTopicIconStickers,
  getGameHighScores,
  getMe,
  getMyCommands,
  getMyDefaultAdministratorRights,
  getMyDescription as getMyDescriptionFn,
  getMyName as getMyNameFn,
  getMyShortDescription as getMyShortDescriptionFn,
  getMyStarBalance,
  getStarTransactions,
  getStickerSet,
  getUserChatBoosts,
  getUserGifts,
  getUserProfileAudios,
  getUserProfilePhotos,
  getWebhookInfoApi,
  giftPremiumSubscription,
  hideGeneralForumTopic,
  leaveChat,
  mapContent,
  pinMessage,
  postStory,
  promoteChatMember,
  reactToMessage,
  readBusinessMessage,
  refundStarPayment,
  removeBusinessAccountProfilePhoto,
  removeMyProfilePhoto,
  reopenForumTopic,
  reopenGeneralForumTopic,
  replaceStickerInSet,
  replyToMessage,
  repostStory,
  restrictChatMember,
  revokeChatInviteLink,
  savePreparedInlineMessage,
  send,
  sendAnimation,
  sendChecklist,
  sendContact,
  sendDice,
  sendGame,
  sendGift,
  sendGiftToChannel,
  sendInvoice,
  sendLocation,
  sendMediaGroup,
  sendPaidMedia,
  sendPoll,
  sendSticker,
  sendVenue,
  sendVideoNote,
  sendVoice,
  setBusinessAccountBio,
  setBusinessAccountGiftSettings,
  setBusinessAccountName,
  setBusinessAccountProfilePhoto,
  setBusinessAccountUsername,
  setChatAdministratorCustomTitle,
  setChatDescription,
  setChatMemberTag,
  setChatMenuButton,
  setChatPermissions,
  setChatPhoto,
  setChatStickerSet,
  setChatTitle,
  setCustomEmojiStickerSetThumbnail,
  setGameScore,
  setMyCommands,
  setMyDefaultAdministratorRights,
  setMyDescription,
  setMyName,
  setMyProfilePhoto,
  setMyShortDescription,
  setStickerEmojiList,
  setStickerKeywords,
  setStickerMaskPosition,
  setStickerPositionInSet,
  setStickerSetThumbnail,
  setStickerSetTitle,
  setUserEmojiStatus,
  setWebhookApi,
  startTyping,
  stopMessageLiveLocation,
  stopMessageLiveLocationInline,
  stopPoll,
  type TgMessage,
  toMessage,
  transferBusinessAccountStars,
  transferGift,
  unbanChatMember,
  unbanChatSenderChat,
  unhideGeneralForumTopic,
  unpinAllForumTopicMessages,
  unpinAllGeneralForumTopicMessages,
  unpinAllMessages,
  unpinMessage,
  upgradeGift,
  uploadStickerFile,
} from "./messages";
import {
  type AcceptedGiftTypesConfig,
  type AdminRights,
  type AnswerInlineQueryOptions,
  type BotCommand,
  type BotInfo,
  type BusinessConnectionEvent,
  type BusinessMessageEvent,
  type BusinessStarBalance,
  type CallbackQuery,
  type ChannelPost,
  type ChatAdminInfo,
  type ChatBoostEvent,
  type ChatBoostRemovedEvent,
  type ChatInfo,
  type ChatInviteLinkInfo,
  type ChatJoinRequestEvent,
  type ChatMemberInfo,
  type ChatMemberUpdateEvent,
  type ChatPermissions,
  type ChecklistParams,
  type ChosenInlineResultEvent,
  type CreateInviteLinkOptions,
  type CreateInvoiceLinkParams,
  configSchema,
  type DeletedBusinessMessagesEvent,
  type EditedMessage,
  type EditInviteLinkOptions,
  type ForumTopicInfo,
  type GameHighScore as GameHighScoreType,
  type GetGameHighScoresOptions,
  type GiftItem,
  type InlineQueryEvent,
  type InputStickerParams,
  type InvoiceParams,
  type MaskPositionParams,
  type MediaGroupItem,
  type MenuButtonResult,
  type MessageReactionEvent,
  type OwnedGiftItem,
  type PaidMediaParams,
  type ParseMode,
  type PollAnswerEvent,
  type PollInfo,
  type PostStoryParams,
  type PreCheckoutQueryEvent,
  type PreparedInlineMessageResult,
  type PurchasedPaidMediaEvent,
  type SavePreparedInlineMessageOptions,
  type SendLocationParams,
  type SendPollParams,
  type SetGameScoreOptions,
  type ShippingOption,
  type ShippingQueryEvent,
  type StarTransaction,
  type StickerFormat,
  type StickerInfo,
  type StickerSetInfo,
  type SuccessfulPaymentEvent,
  spaceSchema,
  type TelegramMessage,
  type UserChatBoost,
  type WebhookInfo as WebhookInfoType,
} from "./types";

const MAX_BUFFERED_EVENTS = 1000;

interface EventSink<T> {
  buffer: T[];
  listener: ((value: T) => void) | null;
  push(value: T): void;
}

const createSink = <T>(): EventSink<T> => {
  const sink: EventSink<T> = {
    buffer: [],
    listener: null,
    push(value: T) {
      if (sink.listener) {
        sink.listener(value);
      } else {
        if (sink.buffer.length >= MAX_BUFFERED_EVENTS) {
          sink.buffer.shift();
        }
        sink.buffer.push(value);
      }
    },
  };
  return sink;
};

const sinkToStream = <T>(sink: EventSink<T>): ManagedStream<T> =>
  stream<T>((emit) => {
    for (const item of sink.buffer) {
      emit(item);
    }
    sink.buffer.length = 0;
    sink.listener = emit;
    return () => {
      sink.listener = null;
    };
  });

interface TelegramEventSinks {
  businessConnections: EventSink<BusinessConnectionEvent>;
  businessMessages: EventSink<BusinessMessageEvent>;
  callbackQueries: EventSink<CallbackQuery>;
  channelPosts: EventSink<ChannelPost>;
  chatBoosts: EventSink<ChatBoostEvent>;
  chatJoinRequests: EventSink<ChatJoinRequestEvent>;
  chatMemberUpdates: EventSink<ChatMemberUpdateEvent>;
  chosenInlineResults: EventSink<ChosenInlineResultEvent>;
  deletedBusinessMessages: EventSink<DeletedBusinessMessagesEvent>;
  editedBusinessMessages: EventSink<BusinessMessageEvent>;
  editedMessages: EventSink<EditedMessage>;
  inlineQueries: EventSink<InlineQueryEvent>;
  messageReactions: EventSink<MessageReactionEvent>;
  messages: EventSink<TelegramMessage>;
  myChatMemberUpdates: EventSink<ChatMemberUpdateEvent>;
  pollAnswers: EventSink<PollAnswerEvent>;
  preCheckoutQueries: EventSink<PreCheckoutQueryEvent>;
  purchasedPaidMedia: EventSink<PurchasedPaidMediaEvent>;
  removedChatBoosts: EventSink<ChatBoostRemovedEvent>;
  shippingQueries: EventSink<ShippingQueryEvent>;
  successfulPayments: EventSink<SuccessfulPaymentEvent>;
}

interface TelegramClient {
  bot: Bot;
  logger: TelegramLogger;
  parseMode?: ParseMode;
  sinks: TelegramEventSinks;
}

export const telegram = definePlatform("Telegram", {
  config: configSchema,

  static: {
    chatActions: {
      typing: "typing",
      uploadPhoto: "upload_photo",
      recordVideo: "record_video",
      uploadVideo: "upload_video",
      recordVoice: "record_voice",
      uploadVoice: "upload_voice",
      uploadDocument: "upload_document",
      chooseSticker: "choose_sticker",
      findLocation: "find_location",
      recordVideoNote: "record_video_note",
      uploadVideoNote: "upload_video_note",
    } as const,

    keyboard: {
      inline: (
        buttons: { text: string; callbackData?: string; url?: string }[][]
      ) => ({
        inline_keyboard: buttons.map((row) =>
          row.map((btn) => ({
            text: btn.text,
            callback_data: btn.callbackData,
            url: btn.url,
          }))
        ),
      }),

      reply: (
        buttons: string[][],
        options?: {
          oneTime?: boolean;
          resizeKeyboard?: boolean;
          inputPlaceholder?: string;
          selective?: boolean;
        }
      ) => ({
        keyboard: buttons.map((row) => row.map((text) => ({ text }))),
        one_time_keyboard: options?.oneTime,
        resize_keyboard: options?.resizeKeyboard ?? true,
        input_field_placeholder: options?.inputPlaceholder,
        selective: options?.selective,
      }),

      remove: (selective?: boolean) => ({
        remove_keyboard: true as const,
        selective,
      }),
    },

    deepLink: {
      private: (botUsername: string, startParam?: string) =>
        startParam
          ? `https://t.me/${botUsername}?start=${startParam}`
          : `https://t.me/${botUsername}`,

      group: (botUsername: string, startGroupParam?: string) =>
        startGroupParam
          ? `https://t.me/${botUsername}?startgroup=${startGroupParam}`
          : `https://t.me/${botUsername}?startgroup`,

      channel: (botUsername: string, startChannelParam?: string) =>
        startChannelParam
          ? `https://t.me/${botUsername}?startchannel=${startChannelParam}`
          : `https://t.me/${botUsername}?startchannel`,
    },

    // Static methods accept TelegramClient by design. Callers obtain it via
    // the platform accessor: `const tg = telegram(space); tg.client` — this
    // keeps the internal client type out of the public Space/Message interface
    // while giving full API access when the caller explicitly opts in.

    // --- Callback / payment query answers ---

    answerCallbackQuery: async (
      client: TelegramClient,
      callbackQueryId: string,
      options?: { text?: string; showAlert?: boolean; url?: string }
    ) => {
      await answerCallbackQuery(
        client.bot,
        callbackQueryId,
        options,
        client.logger
      );
    },

    answerShippingQuery: async (
      client: TelegramClient,
      queryId: string,
      ok: boolean,
      shippingOptions?: ShippingOption[],
      errorMessage?: string
    ) => {
      await answerShippingQuery(
        client.bot,
        queryId,
        ok,
        shippingOptions,
        errorMessage,
        client.logger
      );
    },

    answerPreCheckoutQuery: async (
      client: TelegramClient,
      queryId: string,
      ok: boolean,
      errorMessage?: string
    ) => {
      await answerPreCheckoutQuery(
        client.bot,
        queryId,
        ok,
        errorMessage,
        client.logger
      );
    },

    // --- Payments & Stars ---

    sendInvoice: async (
      client: TelegramClient,
      spaceId: string,
      params: InvoiceParams
    ) => {
      await sendInvoice(client.bot, spaceId, params, client.logger);
    },

    createInvoiceLink: async (
      client: TelegramClient,
      params: CreateInvoiceLinkParams
    ): Promise<string> => {
      return createInvoiceLink(client.bot, params, client.logger);
    },

    sendPaidMedia: async (
      client: TelegramClient,
      spaceId: string,
      params: PaidMediaParams
    ) => {
      await sendPaidMedia(client.bot, spaceId, params, client.logger);
    },

    getMyStarBalance: async (client: TelegramClient): Promise<number> => {
      return getMyStarBalance(client.bot, client.logger);
    },

    getStarTransactions: async (
      client: TelegramClient,
      offset?: number,
      limit?: number
    ): Promise<StarTransaction[]> => {
      return getStarTransactions(client.bot, client.logger, offset, limit);
    },

    refundStarPayment: async (
      client: TelegramClient,
      userId: string,
      telegramPaymentChargeId: string
    ) => {
      await refundStarPayment(
        client.bot,
        userId,
        telegramPaymentChargeId,
        client.logger
      );
    },

    sendGift: async (
      client: TelegramClient,
      userId: string,
      giftId: string,
      text?: string
    ) => {
      await sendGift(client.bot, userId, giftId, client.logger, text);
    },

    // --- Business mode ---

    businessSend: async (
      client: TelegramClient,
      spaceId: string,
      businessConnectionId: string,
      content: Content
    ) => {
      await businessSend(
        client.bot,
        spaceId,
        businessConnectionId,
        content,
        client.logger,
        client.parseMode
      );
    },

    getBusinessConnection: async (
      client: TelegramClient,
      connectionId: string
    ): Promise<BusinessConnectionEvent> => {
      return getBusinessConnection(client.bot, connectionId, client.logger);
    },

    readBusinessMessage: async (
      client: TelegramClient,
      connectionId: string,
      chatId: string,
      messageId: string
    ) => {
      await readBusinessMessage(
        client.bot,
        connectionId,
        chatId,
        messageId,
        client.logger
      );
    },

    deleteBusinessMessages: async (
      client: TelegramClient,
      connectionId: string,
      messageIds: string[]
    ) => {
      await deleteBusinessMessages(
        client.bot,
        connectionId,
        messageIds,
        client.logger
      );
    },

    setBusinessAccountName: async (
      client: TelegramClient,
      connectionId: string,
      firstName: string,
      lastName?: string
    ) => {
      await setBusinessAccountName(
        client.bot,
        connectionId,
        firstName,
        client.logger,
        lastName
      );
    },

    setBusinessAccountBio: async (
      client: TelegramClient,
      connectionId: string,
      bio: string
    ) => {
      await setBusinessAccountBio(client.bot, connectionId, bio, client.logger);
    },

    getBusinessAccountStarBalance: async (
      client: TelegramClient,
      connectionId: string
    ): Promise<BusinessStarBalance> => {
      return getBusinessAccountStarBalance(
        client.bot,
        connectionId,
        client.logger
      );
    },

    transferBusinessAccountStars: async (
      client: TelegramClient,
      connectionId: string,
      starCount: number
    ) => {
      await transferBusinessAccountStars(
        client.bot,
        connectionId,
        starCount,
        client.logger
      );
    },

    deleteStory: async (
      client: TelegramClient,
      connectionId: string,
      storyId: number
    ) => {
      await deleteStory(client.bot, connectionId, storyId, client.logger);
    },

    postStory: async (
      client: TelegramClient,
      connectionId: string,
      params: PostStoryParams
    ): Promise<{ id: number }> => {
      return postStory(client.bot, connectionId, params, client.logger);
    },

    editStory: async (
      client: TelegramClient,
      connectionId: string,
      storyId: number,
      params: PostStoryParams
    ): Promise<{ id: number }> => {
      return editStory(
        client.bot,
        connectionId,
        storyId,
        params,
        client.logger
      );
    },

    // --- Bot commands ---

    setMyCommands: async (client: TelegramClient, commands: BotCommand[]) => {
      await setMyCommands(client.bot, commands, client.logger);
    },

    deleteMyCommands: async (client: TelegramClient) => {
      await deleteMyCommands(client.bot, client.logger);
    },

    getMyCommands: async (client: TelegramClient): Promise<BotCommand[]> => {
      return getMyCommands(client.bot, client.logger);
    },

    // --- Bot profile ---

    setMyName: async (client: TelegramClient, name: string) => {
      await setMyName(client.bot, name, client.logger);
    },

    setMyDescription: async (client: TelegramClient, description: string) => {
      await setMyDescription(client.bot, description, client.logger);
    },

    setMyShortDescription: async (
      client: TelegramClient,
      shortDescription: string
    ) => {
      await setMyShortDescription(client.bot, shortDescription, client.logger);
    },

    setChatMenuButton: async (
      client: TelegramClient,
      chatId?: string,
      menuButton?:
        | { type: "commands" | "default" }
        | { type: "web_app"; text: string; webAppUrl: string }
    ) => {
      await setChatMenuButton(client.bot, client.logger, chatId, menuButton);
    },

    getUserProfilePhotos: async (
      client: TelegramClient,
      userId: string
    ): Promise<string[]> => {
      return getUserProfilePhotos(client.bot, userId, client.logger);
    },

    // --- Chat info & members ---

    getChatInfo: async (
      client: TelegramClient,
      spaceId: string
    ): Promise<ChatInfo> => {
      return getChatInfo(client.bot, spaceId, client.logger);
    },

    getChatMember: async (
      client: TelegramClient,
      spaceId: string,
      userId: string
    ): Promise<ChatMemberInfo> => {
      return getChatMember(client.bot, spaceId, userId, client.logger);
    },

    getChatAdministrators: async (
      client: TelegramClient,
      spaceId: string
    ): Promise<ChatAdminInfo[]> => {
      return getChatAdministrators(client.bot, spaceId, client.logger);
    },

    getChatMemberCount: async (
      client: TelegramClient,
      spaceId: string
    ): Promise<number> => {
      return getChatMemberCount(client.bot, spaceId, client.logger);
    },

    // --- Chat management ---

    banChatMember: async (
      client: TelegramClient,
      spaceId: string,
      userId: string,
      untilDate?: number
    ) => {
      await banChatMember(
        client.bot,
        spaceId,
        userId,
        client.logger,
        untilDate
      );
    },

    unbanChatMember: async (
      client: TelegramClient,
      spaceId: string,
      userId: string,
      onlyIfBanned?: boolean
    ) => {
      await unbanChatMember(
        client.bot,
        spaceId,
        userId,
        client.logger,
        onlyIfBanned
      );
    },

    restrictChatMember: async (
      client: TelegramClient,
      spaceId: string,
      userId: string,
      permissions: ChatPermissions,
      untilDate?: number
    ) => {
      await restrictChatMember(
        client.bot,
        spaceId,
        userId,
        permissions,
        client.logger,
        untilDate
      );
    },

    promoteChatMember: async (
      client: TelegramClient,
      spaceId: string,
      userId: string,
      rights?: {
        canChangeInfo?: boolean;
        canDeleteMessages?: boolean;
        canEditMessages?: boolean;
        canInviteUsers?: boolean;
        canManageChat?: boolean;
        canManageVideoChats?: boolean;
        canPinMessages?: boolean;
        canPostMessages?: boolean;
        canPromoteMembers?: boolean;
        canRestrictMembers?: boolean;
      }
    ) => {
      await promoteChatMember(
        client.bot,
        spaceId,
        userId,
        client.logger,
        rights
      );
    },

    setChatPermissions: async (
      client: TelegramClient,
      spaceId: string,
      permissions: ChatPermissions
    ) => {
      await setChatPermissions(client.bot, spaceId, permissions, client.logger);
    },

    leaveChat: async (client: TelegramClient, spaceId: string) => {
      await leaveChat(client.bot, spaceId, client.logger);
    },

    setChatTitle: async (
      client: TelegramClient,
      spaceId: string,
      title: string
    ) => {
      await setChatTitle(client.bot, spaceId, title, client.logger);
    },

    setChatDescription: async (
      client: TelegramClient,
      spaceId: string,
      description: string
    ) => {
      await setChatDescription(client.bot, spaceId, description, client.logger);
    },

    setChatPhoto: async (
      client: TelegramClient,
      spaceId: string,
      photo: Buffer | string
    ) => {
      await setChatPhoto(client.bot, spaceId, photo, client.logger);
    },

    deleteChatPhoto: async (client: TelegramClient, spaceId: string) => {
      await deleteChatPhoto(client.bot, spaceId, client.logger);
    },

    setChatAdministratorCustomTitle: async (
      client: TelegramClient,
      spaceId: string,
      userId: number,
      customTitle: string
    ) => {
      await setChatAdministratorCustomTitle(
        client.bot,
        spaceId,
        userId,
        customTitle,
        client.logger
      );
    },

    // --- Invite links ---

    exportChatInviteLink: async (
      client: TelegramClient,
      spaceId: string
    ): Promise<string> => {
      return exportChatInviteLink(client.bot, spaceId, client.logger);
    },

    createChatInviteLink: async (
      client: TelegramClient,
      spaceId: string,
      options?: CreateInviteLinkOptions
    ): Promise<ChatInviteLinkInfo> => {
      return createChatInviteLink(client.bot, spaceId, client.logger, options);
    },

    createChatSubscriptionInviteLink: async (
      client: TelegramClient,
      spaceId: string,
      subscriptionPeriod: number,
      subscriptionPrice: number,
      name?: string
    ): Promise<ChatInviteLinkInfo> => {
      return createChatSubscriptionInviteLink(
        client.bot,
        spaceId,
        subscriptionPeriod,
        subscriptionPrice,
        client.logger,
        name
      );
    },

    revokeChatInviteLink: async (
      client: TelegramClient,
      spaceId: string,
      inviteLink: string
    ): Promise<ChatInviteLinkInfo> => {
      return revokeChatInviteLink(
        client.bot,
        spaceId,
        inviteLink,
        client.logger
      );
    },

    editChatInviteLink: async (
      client: TelegramClient,
      spaceId: string,
      inviteLink: string,
      options?: EditInviteLinkOptions
    ): Promise<ChatInviteLinkInfo> => {
      return editChatInviteLink(
        client.bot,
        spaceId,
        inviteLink,
        options,
        client.logger
      );
    },

    editChatSubscriptionInviteLink: async (
      client: TelegramClient,
      spaceId: string,
      inviteLink: string,
      name?: string
    ): Promise<ChatInviteLinkInfo> => {
      return editChatSubscriptionInviteLink(
        client.bot,
        spaceId,
        inviteLink,
        name,
        client.logger
      );
    },

    // --- Forum topics ---

    createForumTopic: async (
      client: TelegramClient,
      spaceId: string,
      name: string,
      iconColor?: number,
      iconCustomEmojiId?: string
    ): Promise<ForumTopicInfo> => {
      return createForumTopic(
        client.bot,
        spaceId,
        name,
        client.logger,
        iconColor,
        iconCustomEmojiId
      );
    },

    editForumTopic: async (
      client: TelegramClient,
      spaceId: string,
      messageThreadId: number,
      name?: string,
      iconCustomEmojiId?: string
    ) => {
      await editForumTopic(
        client.bot,
        spaceId,
        messageThreadId,
        client.logger,
        name,
        iconCustomEmojiId
      );
    },

    closeForumTopic: async (
      client: TelegramClient,
      spaceId: string,
      messageThreadId: number
    ) => {
      await closeForumTopic(
        client.bot,
        spaceId,
        messageThreadId,
        client.logger
      );
    },

    reopenForumTopic: async (
      client: TelegramClient,
      spaceId: string,
      messageThreadId: number
    ) => {
      await reopenForumTopic(
        client.bot,
        spaceId,
        messageThreadId,
        client.logger
      );
    },

    deleteForumTopic: async (
      client: TelegramClient,
      spaceId: string,
      messageThreadId: number
    ) => {
      await deleteForumTopic(
        client.bot,
        spaceId,
        messageThreadId,
        client.logger
      );
    },

    editGeneralForumTopic: async (
      client: TelegramClient,
      spaceId: string,
      name: string
    ) => {
      await editGeneralForumTopic(client.bot, spaceId, name, client.logger);
    },

    closeGeneralForumTopic: async (client: TelegramClient, spaceId: string) => {
      await closeGeneralForumTopic(client.bot, spaceId, client.logger);
    },

    reopenGeneralForumTopic: async (
      client: TelegramClient,
      spaceId: string
    ) => {
      await reopenGeneralForumTopic(client.bot, spaceId, client.logger);
    },

    hideGeneralForumTopic: async (client: TelegramClient, spaceId: string) => {
      await hideGeneralForumTopic(client.bot, spaceId, client.logger);
    },

    unhideGeneralForumTopic: async (
      client: TelegramClient,
      spaceId: string
    ) => {
      await unhideGeneralForumTopic(client.bot, spaceId, client.logger);
    },

    unpinAllForumTopicMessages: async (
      client: TelegramClient,
      spaceId: string,
      messageThreadId: number
    ) => {
      await unpinAllForumTopicMessages(
        client.bot,
        spaceId,
        messageThreadId,
        client.logger
      );
    },

    unpinAllGeneralForumTopicMessages: async (
      client: TelegramClient,
      spaceId: string
    ) => {
      await unpinAllGeneralForumTopicMessages(
        client.bot,
        spaceId,
        client.logger
      );
    },

    // --- Rich content ---

    sendPoll: async (
      client: TelegramClient,
      spaceId: string,
      params: SendPollParams
    ) => {
      await sendPoll(client.bot, spaceId, params, client.logger);
    },

    stopPoll: async (
      client: TelegramClient,
      spaceId: string,
      messageId: string
    ): Promise<PollInfo> => {
      return stopPoll(client.bot, spaceId, messageId, client.logger);
    },

    sendLocation: async (
      client: TelegramClient,
      spaceId: string,
      params: SendLocationParams
    ) => {
      await sendLocation(client.bot, spaceId, params, client.logger);
    },

    editMessageLiveLocation: async (
      client: TelegramClient,
      spaceId: string,
      messageId: string,
      latitude: number,
      longitude: number
    ) => {
      await editMessageLiveLocation(
        client.bot,
        spaceId,
        messageId,
        latitude,
        longitude,
        client.logger
      );
    },

    stopMessageLiveLocation: async (
      client: TelegramClient,
      spaceId: string,
      messageId: string
    ) => {
      await stopMessageLiveLocation(
        client.bot,
        spaceId,
        messageId,
        client.logger
      );
    },

    sendContact: async (
      client: TelegramClient,
      spaceId: string,
      phoneNumber: string,
      firstName: string,
      lastName?: string
    ) => {
      await sendContact(
        client.bot,
        spaceId,
        phoneNumber,
        firstName,
        client.logger,
        lastName
      );
    },

    sendVenue: async (
      client: TelegramClient,
      spaceId: string,
      latitude: number,
      longitude: number,
      title: string,
      address: string
    ) => {
      await sendVenue(
        client.bot,
        spaceId,
        latitude,
        longitude,
        title,
        address,
        client.logger
      );
    },

    sendDice: async (
      client: TelegramClient,
      spaceId: string,
      emoji?: string
    ) => {
      await sendDice(client.bot, spaceId, client.logger, emoji);
    },

    sendSticker: async (
      client: TelegramClient,
      spaceId: string,
      sticker: Buffer | string
    ) => {
      await sendSticker(client.bot, spaceId, sticker, client.logger);
    },

    sendMediaGroup: async (
      client: TelegramClient,
      spaceId: string,
      items: MediaGroupItem[]
    ) => {
      await sendMediaGroup(client.bot, spaceId, items, client.logger);
    },

    editMessageCaption: async (
      client: TelegramClient,
      spaceId: string,
      messageId: number,
      caption: string,
      parseMode?: ParseMode
    ) => {
      await editMessageCaption(
        client.bot,
        spaceId,
        messageId,
        caption,
        parseMode,
        client.logger
      );
    },

    editMessageReplyMarkup: async (
      client: TelegramClient,
      spaceId: string,
      messageId: number,
      replyMarkup: InlineKeyboardMarkup
    ) => {
      await editMessageReplyMarkup(
        client.bot,
        spaceId,
        messageId,
        replyMarkup,
        client.logger
      );
    },

    // --- Bulk operations ---

    forwardMessages: async (
      client: TelegramClient,
      fromSpaceId: string,
      toSpaceId: string,
      messageIds: string[]
    ) => {
      await forwardMessages(
        client.bot,
        fromSpaceId,
        toSpaceId,
        messageIds,
        client.logger
      );
    },

    copyMessages: async (
      client: TelegramClient,
      fromSpaceId: string,
      toSpaceId: string,
      messageIds: string[]
    ) => {
      await copyMessages(
        client.bot,
        fromSpaceId,
        toSpaceId,
        messageIds,
        client.logger
      );
    },

    deleteMessages: async (
      client: TelegramClient,
      spaceId: string,
      messageIds: string[]
    ) => {
      await deleteMessages(client.bot, spaceId, messageIds, client.logger);
    },

    unpinAllMessages: async (client: TelegramClient, spaceId: string) => {
      await unpinAllMessages(client.bot, spaceId, client.logger);
    },

    // --- Join request management ---

    approveChatJoinRequest: async (
      client: TelegramClient,
      spaceId: string,
      userId: string
    ) => {
      await approveChatJoinRequest(client.bot, spaceId, userId, client.logger);
    },

    declineChatJoinRequest: async (
      client: TelegramClient,
      spaceId: string,
      userId: string
    ) => {
      await declineChatJoinRequest(client.bot, spaceId, userId, client.logger);
    },

    // --- Additional media senders ---

    sendAnimation: async (
      client: TelegramClient,
      spaceId: string,
      animation: Buffer | string,
      caption?: string,
      parseMode?: ParseMode
    ) => {
      await sendAnimation(
        client.bot,
        spaceId,
        animation,
        caption,
        parseMode,
        client.logger
      );
    },

    sendVoice: async (
      client: TelegramClient,
      spaceId: string,
      voice: Buffer | string,
      caption?: string,
      parseMode?: ParseMode
    ) => {
      await sendVoice(
        client.bot,
        spaceId,
        voice,
        caption,
        parseMode,
        client.logger
      );
    },

    sendVideoNote: async (
      client: TelegramClient,
      spaceId: string,
      videoNote: Buffer | string
    ) => {
      await sendVideoNote(client.bot, spaceId, videoNote, client.logger);
    },

    // --- Bot identity ---

    getMe: async (client: TelegramClient): Promise<BotInfo> => {
      return getMe(client.bot, client.logger);
    },

    logOut: async (client: TelegramClient) => {
      await botLogOut(client.bot, client.logger);
    },

    close: async (client: TelegramClient) => {
      await botClose(client.bot, client.logger);
    },

    // --- Bot profile getters ---

    getMyName: async (client: TelegramClient): Promise<string> => {
      return getMyNameFn(client.bot, client.logger);
    },

    getMyDescription: async (client: TelegramClient): Promise<string> => {
      return getMyDescriptionFn(client.bot, client.logger);
    },

    getMyShortDescription: async (client: TelegramClient): Promise<string> => {
      return getMyShortDescriptionFn(client.bot, client.logger);
    },

    getChatMenuButton: async (
      client: TelegramClient,
      chatId?: string
    ): Promise<MenuButtonResult> => {
      return getChatMenuButtonFn(client.bot, chatId, client.logger);
    },

    // --- Default administrator rights ---

    setMyDefaultAdministratorRights: async (
      client: TelegramClient,
      rights?: AdminRights,
      forChannels?: boolean
    ) => {
      await setMyDefaultAdministratorRights(
        client.bot,
        rights,
        forChannels,
        client.logger
      );
    },

    getMyDefaultAdministratorRights: async (
      client: TelegramClient,
      forChannels?: boolean
    ): Promise<AdminRights> => {
      return getMyDefaultAdministratorRights(
        client.bot,
        forChannels,
        client.logger
      );
    },

    // --- Channel ban + boosts + member tags ---

    banChatSenderChat: async (
      client: TelegramClient,
      spaceId: string,
      senderChatId: number
    ) => {
      await banChatSenderChat(client.bot, spaceId, senderChatId, client.logger);
    },

    unbanChatSenderChat: async (
      client: TelegramClient,
      spaceId: string,
      senderChatId: number
    ) => {
      await unbanChatSenderChat(
        client.bot,
        spaceId,
        senderChatId,
        client.logger
      );
    },

    getUserChatBoosts: async (
      client: TelegramClient,
      spaceId: string,
      userId: number
    ): Promise<UserChatBoost[]> => {
      return getUserChatBoosts(client.bot, spaceId, userId, client.logger);
    },

    setChatMemberTag: async (
      client: TelegramClient,
      spaceId: string,
      userId: number,
      tag: string
    ) => {
      await setChatMemberTag(client.bot, spaceId, userId, tag, client.logger);
    },

    // --- Webhook management ---

    setWebhook: async (
      client: TelegramClient,
      url: string,
      options?: {
        certificate?: Buffer;
        dropPendingUpdates?: boolean;
        ipAddress?: string;
        maxConnections?: number;
        secretToken?: string;
      }
    ) => {
      await setWebhookApi(client.bot, url, options, client.logger);
    },

    deleteWebhook: async (
      client: TelegramClient,
      dropPendingUpdates?: boolean
    ) => {
      await deleteWebhookApi(client.bot, dropPendingUpdates, client.logger);
    },

    getWebhookInfo: async (
      client: TelegramClient
    ): Promise<WebhookInfoType> => {
      return getWebhookInfoApi(client.bot, client.logger);
    },

    // --- Gifts ---

    getAvailableGifts: async (client: TelegramClient): Promise<GiftItem[]> => {
      return getAvailableGifts(client.bot, client.logger);
    },

    getUserGifts: async (
      client: TelegramClient,
      userId: number
    ): Promise<OwnedGiftItem[]> => {
      return getUserGifts(client.bot, userId, client.logger);
    },

    getChatGifts: async (
      client: TelegramClient,
      chatId: number
    ): Promise<OwnedGiftItem[]> => {
      return getChatGifts(client.bot, chatId, client.logger);
    },

    sendGiftToChannel: async (
      client: TelegramClient,
      chatId: string,
      giftId: string
    ) => {
      await sendGiftToChannel(client.bot, chatId, giftId, client.logger);
    },

    transferGift: async (
      client: TelegramClient,
      connectionId: string,
      ownedGiftId: string,
      newOwnerChatId: number,
      starCount: number
    ) => {
      await transferGift(
        client.bot,
        connectionId,
        ownedGiftId,
        newOwnerChatId,
        starCount,
        client.logger
      );
    },

    upgradeGift: async (
      client: TelegramClient,
      connectionId: string,
      ownedGiftId: string
    ) => {
      await upgradeGift(client.bot, connectionId, ownedGiftId, client.logger);
    },

    convertGiftToStars: async (
      client: TelegramClient,
      connectionId: string,
      ownedGiftId: string
    ) => {
      await convertGiftToStars(
        client.bot,
        connectionId,
        ownedGiftId,
        client.logger
      );
    },

    giftPremiumSubscription: async (
      client: TelegramClient,
      userId: number,
      monthCount: 3 | 6 | 12,
      starCount: 1000 | 1500 | 2500,
      text?: string
    ) => {
      await giftPremiumSubscription(
        client.bot,
        userId,
        monthCount,
        starCount,
        text,
        client.logger
      );
    },

    // --- Extended business ---

    repostStory: async (
      client: TelegramClient,
      connectionId: string,
      fromChatId: number,
      fromStoryId: number,
      activePeriod: number
    ): Promise<{ id: number }> => {
      return repostStory(
        client.bot,
        connectionId,
        fromChatId,
        fromStoryId,
        activePeriod,
        client.logger
      );
    },

    setBusinessAccountProfilePhoto: async (
      client: TelegramClient,
      connectionId: string,
      photoData: Buffer,
      isPublic?: boolean
    ) => {
      await setBusinessAccountProfilePhoto(
        client.bot,
        connectionId,
        photoData,
        isPublic,
        client.logger
      );
    },

    removeBusinessAccountProfilePhoto: async (
      client: TelegramClient,
      connectionId: string,
      isPublic?: boolean
    ) => {
      await removeBusinessAccountProfilePhoto(
        client.bot,
        connectionId,
        isPublic,
        client.logger
      );
    },

    setBusinessAccountUsername: async (
      client: TelegramClient,
      connectionId: string,
      username: string
    ) => {
      await setBusinessAccountUsername(
        client.bot,
        connectionId,
        username,
        client.logger
      );
    },

    setBusinessAccountGiftSettings: async (
      client: TelegramClient,
      connectionId: string,
      showGiftButton: boolean,
      acceptedTypes: AcceptedGiftTypesConfig
    ) => {
      await setBusinessAccountGiftSettings(
        client.bot,
        connectionId,
        showGiftButton,
        acceptedTypes,
        client.logger
      );
    },

    getBusinessAccountGifts: async (
      client: TelegramClient,
      connectionId: string
    ): Promise<OwnedGiftItem[]> => {
      return getBusinessAccountGifts(client.bot, connectionId, client.logger);
    },

    // --- Profile photo management ---

    setMyProfilePhoto: async (client: TelegramClient, photoData: Buffer) => {
      await setMyProfilePhoto(client.bot, photoData, client.logger);
    },

    removeMyProfilePhoto: async (client: TelegramClient) => {
      await removeMyProfilePhoto(client.bot, client.logger);
    },

    getUserProfileAudios: async (
      client: TelegramClient,
      userId: number
    ): Promise<number> => {
      return getUserProfileAudios(client.bot, userId, client.logger);
    },

    setUserEmojiStatus: async (
      client: TelegramClient,
      userId: number,
      emojiStatusCustomEmojiId?: string,
      emojiStatusExpirationDate?: number
    ) => {
      await setUserEmojiStatus(
        client.bot,
        userId,
        emojiStatusCustomEmojiId,
        emojiStatusExpirationDate,
        client.logger
      );
    },

    // --- Star subscriptions ---

    editUserStarSubscription: async (
      client: TelegramClient,
      userId: number,
      telegramPaymentChargeId: string,
      isCanceled: boolean
    ) => {
      await editUserStarSubscription(
        client.bot,
        userId,
        telegramPaymentChargeId,
        isCanceled,
        client.logger
      );
    },

    // --- Checklists ---

    sendChecklist: async (
      client: TelegramClient,
      connectionId: string,
      chatId: number,
      checklist: ChecklistParams
    ) => {
      await sendChecklist(
        client.bot,
        connectionId,
        chatId,
        checklist,
        client.logger
      );
    },

    editMessageChecklist: async (
      client: TelegramClient,
      connectionId: string,
      chatId: number,
      messageId: number,
      checklist: ChecklistParams
    ) => {
      await editMessageChecklist(
        client.bot,
        connectionId,
        chatId,
        messageId,
        checklist,
        client.logger
      );
    },

    // --- Web app queries ---

    answerWebAppQuery: async (
      client: TelegramClient,
      webAppQueryId: string,
      result: Record<string, unknown>
    ): Promise<string | undefined> => {
      return answerWebAppQuery(
        client.bot,
        webAppQueryId,
        result,
        client.logger
      );
    },

    // --- Suggested posts ---

    approveSuggestedPost: async (
      client: TelegramClient,
      chatId: number,
      messageId: number,
      scheduledDate?: number
    ) => {
      await approveSuggestedPost(
        client.bot,
        chatId,
        messageId,
        scheduledDate,
        client.logger
      );
    },

    declineSuggestedPost: async (
      client: TelegramClient,
      chatId: number,
      messageId: number
    ) => {
      await declineSuggestedPost(client.bot, chatId, messageId, client.logger);
    },

    // --- Sticker management ---

    getStickerSet: async (
      client: TelegramClient,
      name: string
    ): Promise<StickerSetInfo> => {
      return getStickerSet(client.bot, name, client.logger);
    },

    getCustomEmojiStickers: async (
      client: TelegramClient,
      customEmojiIds: string[]
    ): Promise<StickerInfo[]> => {
      return getCustomEmojiStickers(client.bot, customEmojiIds, client.logger);
    },

    getForumTopicIconStickers: async (
      client: TelegramClient
    ): Promise<StickerInfo[]> => {
      return getForumTopicIconStickers(client.bot, client.logger);
    },

    uploadStickerFile: async (
      client: TelegramClient,
      userId: number,
      stickerFormat: StickerFormat,
      sticker: Buffer
    ): Promise<string> => {
      return uploadStickerFile(
        client.bot,
        userId,
        stickerFormat,
        sticker,
        client.logger
      );
    },

    createNewStickerSet: async (
      client: TelegramClient,
      userId: number,
      name: string,
      title: string,
      stickers: InputStickerParams[],
      stickerType?: "custom_emoji" | "mask" | "regular"
    ) => {
      await createNewStickerSet(
        client.bot,
        userId,
        name,
        title,
        stickers,
        stickerType,
        client.logger
      );
    },

    addStickerToSet: async (
      client: TelegramClient,
      userId: number,
      name: string,
      sticker: InputStickerParams
    ) => {
      await addStickerToSet(client.bot, userId, name, sticker, client.logger);
    },

    setStickerPositionInSet: async (
      client: TelegramClient,
      sticker: string,
      position: number
    ) => {
      await setStickerPositionInSet(
        client.bot,
        sticker,
        position,
        client.logger
      );
    },

    deleteStickerFromSet: async (client: TelegramClient, sticker: string) => {
      await deleteStickerFromSet(client.bot, sticker, client.logger);
    },

    replaceStickerInSet: async (
      client: TelegramClient,
      userId: number,
      name: string,
      oldSticker: string,
      sticker: InputStickerParams
    ) => {
      await replaceStickerInSet(
        client.bot,
        userId,
        name,
        oldSticker,
        sticker,
        client.logger
      );
    },

    setStickerEmojiList: async (
      client: TelegramClient,
      sticker: string,
      emojiList: string[]
    ) => {
      await setStickerEmojiList(client.bot, sticker, emojiList, client.logger);
    },

    setStickerKeywords: async (
      client: TelegramClient,
      sticker: string,
      keywords: string[]
    ) => {
      await setStickerKeywords(client.bot, sticker, keywords, client.logger);
    },

    setStickerMaskPosition: async (
      client: TelegramClient,
      sticker: string,
      maskPosition?: MaskPositionParams
    ) => {
      await setStickerMaskPosition(
        client.bot,
        sticker,
        maskPosition,
        client.logger
      );
    },

    setStickerSetTitle: async (
      client: TelegramClient,
      name: string,
      title: string
    ) => {
      await setStickerSetTitle(client.bot, name, title, client.logger);
    },

    deleteStickerSet: async (client: TelegramClient, name: string) => {
      await deleteStickerSet(client.bot, name, client.logger);
    },

    setStickerSetThumbnail: async (
      client: TelegramClient,
      name: string,
      userId: number,
      format: StickerFormat,
      thumbnail?: Buffer | string
    ) => {
      await setStickerSetThumbnail(
        client.bot,
        name,
        userId,
        format,
        thumbnail,
        client.logger
      );
    },

    setCustomEmojiStickerSetThumbnail: async (
      client: TelegramClient,
      name: string,
      customEmojiId: string
    ) => {
      await setCustomEmojiStickerSetThumbnail(
        client.bot,
        name,
        customEmojiId,
        client.logger
      );
    },

    setChatStickerSet: async (
      client: TelegramClient,
      spaceId: string,
      stickerSetName: string
    ) => {
      await setChatStickerSet(
        client.bot,
        spaceId,
        stickerSetName,
        client.logger
      );
    },

    deleteChatStickerSet: async (client: TelegramClient, spaceId: string) => {
      await deleteChatStickerSet(client.bot, spaceId, client.logger);
    },

    // --- Inline Mode ---

    answerInlineQuery: async (
      client: TelegramClient,
      inlineQueryId: string,
      results: InlineQueryResult[],
      options?: AnswerInlineQueryOptions
    ) => {
      await answerInlineQuery(
        client.bot,
        inlineQueryId,
        results,
        options,
        client.logger
      );
    },

    savePreparedInlineMessage: async (
      client: TelegramClient,
      userId: string,
      result: InlineQueryResult,
      options?: SavePreparedInlineMessageOptions
    ): Promise<PreparedInlineMessageResult> => {
      return savePreparedInlineMessage(
        client.bot,
        userId,
        result,
        options,
        client.logger
      );
    },

    editMessageTextInline: async (
      client: TelegramClient,
      inlineMessageId: string,
      text: string,
      options?: { parseMode?: ParseMode }
    ) => {
      await editMessageTextInline(
        client.bot,
        inlineMessageId,
        text,
        options,
        client.logger
      );
    },

    editMessageCaptionInline: async (
      client: TelegramClient,
      inlineMessageId: string,
      caption: string,
      options?: { parseMode?: ParseMode }
    ) => {
      await editMessageCaptionInline(
        client.bot,
        inlineMessageId,
        caption,
        options,
        client.logger
      );
    },

    editMessageReplyMarkupInline: async (
      client: TelegramClient,
      inlineMessageId: string,
      replyMarkup?: InlineKeyboardMarkup
    ) => {
      await editMessageReplyMarkupInline(
        client.bot,
        inlineMessageId,
        replyMarkup,
        client.logger
      );
    },

    editMessageLiveLocationInline: async (
      client: TelegramClient,
      inlineMessageId: string,
      latitude: number,
      longitude: number,
      options?: {
        heading?: number;
        horizontalAccuracy?: number;
        proximityAlertRadius?: number;
      }
    ) => {
      await editMessageLiveLocationInline(
        client.bot,
        inlineMessageId,
        latitude,
        longitude,
        options,
        client.logger
      );
    },

    stopMessageLiveLocationInline: async (
      client: TelegramClient,
      inlineMessageId: string
    ) => {
      await stopMessageLiveLocationInline(
        client.bot,
        inlineMessageId,
        client.logger
      );
    },

    // --- HTML5 Games ---

    sendGame: async (
      client: TelegramClient,
      chatId: string,
      gameShortName: string,
      options?: {
        disableNotification?: boolean;
        protectContent?: boolean;
        replyMarkup?: InlineKeyboardMarkup;
      }
    ): Promise<string> => {
      return sendGame(
        client.bot,
        chatId,
        gameShortName,
        options,
        client.logger
      );
    },

    setGameScore: async (
      client: TelegramClient,
      userId: string,
      score: number,
      options?: SetGameScoreOptions
    ) => {
      await setGameScore(client.bot, userId, score, options, client.logger);
    },

    getGameHighScores: async (
      client: TelegramClient,
      userId: string,
      options?: GetGameHighScoresOptions
    ): Promise<GameHighScoreType[]> => {
      return getGameHighScores(client.bot, userId, options, client.logger);
    },
  },

  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    resolve: async ({ input }) => {
      if (input.users.length === 0) {
        throw new Error("Telegram space creation requires at least one user");
      }
      if (input.users.length > 1) {
        throw new Error(
          "Telegram Bot API only supports 1:1 conversations initiated by the user"
        );
      }
      const user = input.users[0];
      if (!user) {
        throw new Error("Telegram space creation requires a user");
      }
      return {
        id: user.id,
        type: "private" as "private" | "group" | "supergroup" | "channel",
      };
    },
  },

  lifecycle: {
    createClient: async ({ config }): Promise<TelegramClient> => {
      const logger = createLogger(config.logLevel);
      const bot = new Bot(config.token);
      await bot.init();
      logger.info(`Bot initialized: @${bot.botInfo.username}`);

      const sinks: TelegramEventSinks = {
        messages: createSink(),
        editedMessages: createSink(),
        channelPosts: createSink(),
        callbackQueries: createSink(),
        shippingQueries: createSink(),
        preCheckoutQueries: createSink(),
        successfulPayments: createSink(),
        businessConnections: createSink(),
        businessMessages: createSink(),
        editedBusinessMessages: createSink(),
        deletedBusinessMessages: createSink(),
        messageReactions: createSink(),
        chatJoinRequests: createSink(),
        myChatMemberUpdates: createSink(),
        chatMemberUpdates: createSink(),
        chatBoosts: createSink(),
        removedChatBoosts: createSink(),
        pollAnswers: createSink(),
        purchasedPaidMedia: createSink(),
        inlineQueries: createSink(),
        chosenInlineResults: createSink(),
      };

      bot.on("message", (ctx) => {
        if (ctx.message) {
          sinks.messages.push(toMessage(bot, ctx.message));
        }
      });
      bot.on("edited_message", (ctx) => {
        const msg = ctx.editedMessage;
        if (!msg) {
          return;
        }
        sinks.editedMessages.push({
          id: String(msg.message_id),
          content: mapContent(bot, msg as unknown as TgMessage),
          sender: { id: String(msg.from?.id ?? msg.chat.id) },
          space: { id: String(msg.chat.id), type: msg.chat.type },
          editDate: new Date((msg.edit_date ?? msg.date) * 1000),
        });
      });
      bot.on("channel_post", (ctx) => {
        const post = ctx.channelPost;
        if (!post) {
          return;
        }
        sinks.channelPosts.push({
          id: String(post.message_id),
          content: mapContent(bot, post as unknown as TgMessage),
          space: { id: String(post.chat.id), type: "channel" },
          timestamp: new Date(post.date * 1000),
        });
      });
      bot.on("callback_query", (ctx) => {
        const q = ctx.callbackQuery;
        sinks.callbackQueries.push({
          id: q.id,
          chatInstance: q.chat_instance,
          data: q.data,
          gameShortName: q.game_short_name,
          messageId: q.message ? String(q.message.message_id) : undefined,
          sender: { id: String(q.from.id) },
          space: q.message
            ? { id: String(q.message.chat.id), type: q.message.chat.type }
            : undefined,
        });
      });
      bot.on("shipping_query", (ctx) => {
        const q = ctx.shippingQuery;
        sinks.shippingQueries.push({
          id: q.id,
          sender: { id: String(q.from.id) },
          invoicePayload: q.invoice_payload,
          shippingAddress: {
            countryCode: q.shipping_address.country_code,
            state: q.shipping_address.state,
            city: q.shipping_address.city,
            streetLine1: q.shipping_address.street_line1,
            streetLine2: q.shipping_address.street_line2,
            postCode: q.shipping_address.post_code,
          },
        });
      });
      bot.on("pre_checkout_query", (ctx) => {
        const q = ctx.preCheckoutQuery;
        sinks.preCheckoutQueries.push({
          id: q.id,
          sender: { id: String(q.from.id) },
          currency: q.currency,
          totalAmount: q.total_amount,
          invoicePayload: q.invoice_payload,
        });
      });
      bot.on("message:successful_payment", (ctx) => {
        const p = ctx.message.successful_payment;
        sinks.successfulPayments.push({
          sender: {
            id: String(ctx.message.from?.id ?? ctx.message.chat.id),
          },
          space: {
            id: String(ctx.message.chat.id),
            type: ctx.message.chat.type,
          },
          currency: p.currency,
          totalAmount: p.total_amount,
          invoicePayload: p.invoice_payload,
        });
      });
      bot.on("business_connection", (ctx) => {
        const c = ctx.businessConnection;
        sinks.businessConnections.push({
          id: c.id,
          userId: String(c.user.id),
          userChatId: String(c.user_chat_id),
          isEnabled: c.is_enabled,
          rights: c.rights
            ? {
                canReply: c.rights.can_reply ?? false,
                canReadMessages: c.rights.can_read_messages ?? false,
                canDeleteOutgoingMessages:
                  c.rights.can_delete_outgoing_messages ?? false,
                canDeleteAllMessages: c.rights.can_delete_all_messages ?? false,
                canEditName: c.rights.can_edit_name ?? false,
                canEditBio: c.rights.can_edit_bio ?? false,
                canEditProfilePhoto: c.rights.can_edit_profile_photo ?? false,
                canEditUsername: c.rights.can_edit_username ?? false,
              }
            : undefined,
          date: new Date(c.date * 1000),
        });
      });
      bot.on("business_message", (ctx) => {
        const msg = ctx.update.business_message;
        if (!msg) {
          return;
        }
        try {
          sinks.businessMessages.push({
            id: String(msg.message_id),
            businessConnectionId: msg.business_connection_id ?? "",
            content: mapContent(bot, msg as unknown as TgMessage),
            sender: { id: String(msg.from?.id ?? msg.chat.id) },
            space: { id: String(msg.chat.id), type: msg.chat.type },
            timestamp: new Date(msg.date * 1000),
          });
        } catch (err) {
          logger.error("Failed to process business message", err);
        }
      });
      bot.on("edited_business_message", (ctx) => {
        const msg = ctx.update.edited_business_message;
        if (!msg) {
          return;
        }
        try {
          sinks.editedBusinessMessages.push({
            id: String(msg.message_id),
            businessConnectionId: msg.business_connection_id ?? "",
            content: mapContent(bot, msg as unknown as TgMessage),
            sender: { id: String(msg.from?.id ?? msg.chat.id) },
            space: { id: String(msg.chat.id), type: msg.chat.type },
            timestamp: new Date((msg.edit_date ?? msg.date) * 1000),
          });
        } catch (err) {
          logger.error("Failed to process edited business message", err);
        }
      });
      bot.on("deleted_business_messages", (ctx) => {
        const del = ctx.update.deleted_business_messages;
        if (!del) {
          return;
        }
        sinks.deletedBusinessMessages.push({
          businessConnectionId: del.business_connection_id,
          space: { id: String(del.chat.id), type: del.chat.type },
          messageIds: del.message_ids.map(String),
        });
      });
      bot.on("message_reaction", (ctx) => {
        const r = ctx.messageReaction;
        sinks.messageReactions.push({
          space: { id: String(r.chat.id), type: r.chat.type },
          messageId: String(r.message_id),
          actorId: r.user ? String(r.user.id) : String(r.actor_chat?.id ?? 0),
          date: new Date(r.date * 1000),
          oldReactions: r.old_reaction.map((rx) => ({
            type: rx.type,
            emoji: "emoji" in rx ? rx.emoji : undefined,
            customEmojiId:
              "custom_emoji_id" in rx ? rx.custom_emoji_id : undefined,
          })),
          newReactions: r.new_reaction.map((rx) => ({
            type: rx.type,
            emoji: "emoji" in rx ? rx.emoji : undefined,
            customEmojiId:
              "custom_emoji_id" in rx ? rx.custom_emoji_id : undefined,
          })),
        });
      });
      bot.on("chat_join_request", (ctx) => {
        const req = ctx.chatJoinRequest;
        sinks.chatJoinRequests.push({
          space: { id: String(req.chat.id), type: req.chat.type },
          userId: String(req.from.id),
          date: new Date(req.date * 1000),
          bio: req.bio ?? undefined,
          inviteLink: req.invite_link?.invite_link ?? undefined,
        });
      });
      bot.on("my_chat_member", (ctx) => {
        const u = ctx.myChatMember;
        sinks.myChatMemberUpdates.push({
          space: { id: String(u.chat.id), type: u.chat.type },
          userId: String(u.new_chat_member.user.id),
          date: new Date(u.date * 1000),
          oldStatus: u.old_chat_member.status,
          newStatus: u.new_chat_member.status,
        });
      });
      bot.on("chat_member", (ctx) => {
        const u = ctx.chatMember;
        sinks.chatMemberUpdates.push({
          space: { id: String(u.chat.id), type: u.chat.type },
          userId: String(u.new_chat_member.user.id),
          date: new Date(u.date * 1000),
          oldStatus: u.old_chat_member.status,
          newStatus: u.new_chat_member.status,
        });
      });
      bot.on("chat_boost", (ctx) => {
        const b = ctx.chatBoost;
        sinks.chatBoosts.push({
          space: { id: String(b.chat.id), type: b.chat.type },
          boostId: b.boost.boost_id,
          date: new Date(b.boost.add_date * 1000),
          expirationDate: new Date(b.boost.expiration_date * 1000),
          source: b.boost.source.source,
        });
      });
      bot.on("removed_chat_boost", (ctx) => {
        const b = ctx.removedChatBoost;
        sinks.removedChatBoosts.push({
          space: { id: String(b.chat.id), type: b.chat.type },
          boostId: b.boost_id,
          removeDate: new Date(b.remove_date * 1000),
          source: b.source.source,
        });
      });
      bot.on("poll_answer", (ctx) => {
        const a = ctx.pollAnswer;
        sinks.pollAnswers.push({
          pollId: a.poll_id,
          userId: a.user ? String(a.user.id) : "",
          optionIds: [...a.option_ids],
        });
      });
      bot.on("purchased_paid_media", (ctx) => {
        const p = ctx.update.purchased_paid_media;
        if (!p) {
          return;
        }
        sinks.purchasedPaidMedia.push({
          userId: String(p.from.id),
          space: { id: "", type: "private" },
          payload: p.paid_media_payload ?? "",
        });
      });
      bot.on("inline_query", (ctx) => {
        const iq = ctx.inlineQuery;
        sinks.inlineQueries.push({
          id: iq.id,
          from: { id: String(iq.from.id) },
          query: iq.query,
          offset: iq.offset,
          chatType: iq.chat_type as InlineQueryEvent["chatType"],
          location: iq.location
            ? {
                latitude: iq.location.latitude,
                longitude: iq.location.longitude,
              }
            : undefined,
        });
      });
      bot.on("chosen_inline_result", (ctx) => {
        const r = ctx.chosenInlineResult;
        sinks.chosenInlineResults.push({
          resultId: r.result_id,
          from: { id: String(r.from.id) },
          query: r.query,
          inlineMessageId: r.inline_message_id,
          location: r.location
            ? {
                latitude: r.location.latitude,
                longitude: r.location.longitude,
              }
            : undefined,
        });
      });

      bot.catch((err) => {
        logger.error("Bot error", err.error);
      });

      // bot.start() is intentionally not awaited — its promise never resolves
      // while polling is active, so awaiting it would block createClient forever.
      // Startup errors (bad token, network) surface through bot.catch() above.
      bot
        .start({
          allowed_updates: [
            "message",
            "edited_message",
            "channel_post",
            "edited_channel_post",
            "inline_query",
            "chosen_inline_result",
            "callback_query",
            "shipping_query",
            "pre_checkout_query",
            "poll",
            "poll_answer",
            "my_chat_member",
            "chat_member",
            "chat_join_request",
            "chat_boost",
            "removed_chat_boost",
            "message_reaction",
            "message_reaction_count",
            "business_connection",
            "business_message",
            "edited_business_message",
            "deleted_business_messages",
            "purchased_paid_media",
          ],
        })
        .catch((err) => {
          logger.error("Bot polling failed", err);
        });

      return {
        bot,
        logger,
        parseMode: config.parseMode,
        sinks,
      };
    },

    destroyClient: async ({ client }: { client: TelegramClient }) => {
      await client.bot.stop();
    },
  },

  events: {
    messages: ({ client }: { client: TelegramClient }) =>
      sinkToStream(client.sinks.messages) as AsyncIterable<TelegramMessage>,
    editedMessages: ({ client }: { client: TelegramClient }) =>
      sinkToStream(client.sinks.editedMessages) as AsyncIterable<EditedMessage>,
    channelPosts: ({ client }: { client: TelegramClient }) =>
      sinkToStream(client.sinks.channelPosts) as AsyncIterable<ChannelPost>,
    callbackQueries: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.callbackQueries
      ) as AsyncIterable<CallbackQuery>,
    shippingQueries: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.shippingQueries
      ) as AsyncIterable<ShippingQueryEvent>,
    preCheckoutQueries: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.preCheckoutQueries
      ) as AsyncIterable<PreCheckoutQueryEvent>,
    successfulPayments: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.successfulPayments
      ) as AsyncIterable<SuccessfulPaymentEvent>,
    businessConnections: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.businessConnections
      ) as AsyncIterable<BusinessConnectionEvent>,
    businessMessages: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.businessMessages
      ) as AsyncIterable<BusinessMessageEvent>,
    editedBusinessMessages: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.editedBusinessMessages
      ) as AsyncIterable<BusinessMessageEvent>,
    deletedBusinessMessages: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.deletedBusinessMessages
      ) as AsyncIterable<DeletedBusinessMessagesEvent>,
    messageReactions: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.messageReactions
      ) as AsyncIterable<MessageReactionEvent>,
    chatJoinRequests: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.chatJoinRequests
      ) as AsyncIterable<ChatJoinRequestEvent>,
    myChatMemberUpdates: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.myChatMemberUpdates
      ) as AsyncIterable<ChatMemberUpdateEvent>,
    chatMemberUpdates: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.chatMemberUpdates
      ) as AsyncIterable<ChatMemberUpdateEvent>,
    chatBoosts: ({ client }: { client: TelegramClient }) =>
      sinkToStream(client.sinks.chatBoosts) as AsyncIterable<ChatBoostEvent>,
    removedChatBoosts: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.removedChatBoosts
      ) as AsyncIterable<ChatBoostRemovedEvent>,
    pollAnswers: ({ client }: { client: TelegramClient }) =>
      sinkToStream(client.sinks.pollAnswers) as AsyncIterable<PollAnswerEvent>,
    purchasedPaidMedia: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.purchasedPaidMedia
      ) as AsyncIterable<PurchasedPaidMediaEvent>,
    inlineQueries: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.inlineQueries
      ) as AsyncIterable<InlineQueryEvent>,
    chosenInlineResults: ({ client }: { client: TelegramClient }) =>
      sinkToStream(
        client.sinks.chosenInlineResults
      ) as AsyncIterable<ChosenInlineResultEvent>,
  },

  actions: {
    send: async ({ space, content, client }) => {
      const c = client as TelegramClient;
      await send(c.bot, space.id, content, c.logger, c.parseMode);
    },

    startTyping: async ({ space, client }) => {
      const c = client as TelegramClient;
      await startTyping(c.bot, space.id);
    },

    stopTyping: async () => {
      // Telegram auto-clears typing after 5s or when a message is sent
    },

    reactToMessage: async ({ space, messageId, reaction, client }) => {
      const c = client as TelegramClient;
      await reactToMessage(c.bot, space.id, messageId, reaction, c.logger);
    },

    replyToMessage: async ({ space, messageId, content, client }) => {
      const c = client as TelegramClient;
      await replyToMessage(
        c.bot,
        space.id,
        messageId,
        content,
        c.logger,
        c.parseMode
      );
    },

    editMessage: async ({ space, messageId, content, client }) => {
      const c = client as TelegramClient;
      await editMessage(
        c.bot,
        space.id,
        messageId,
        content,
        c.logger,
        c.parseMode
      );
    },

    deleteMessage: async ({ space, messageId, client }) => {
      const c = client as TelegramClient;
      await deleteMessage(c.bot, space.id, messageId, c.logger);
    },

    forwardMessage: async ({ space, messageId, toSpaceId, client }) => {
      const c = client as TelegramClient;
      await forwardMessage(c.bot, space.id, messageId, toSpaceId, c.logger);
    },

    copyMessage: async ({ space, messageId, toSpaceId, client }) => {
      const c = client as TelegramClient;
      await copyMessage(c.bot, space.id, messageId, toSpaceId, c.logger);
    },

    pinMessage: async ({ space, messageId, client }) => {
      const c = client as TelegramClient;
      await pinMessage(c.bot, space.id, messageId, c.logger);
    },

    unpinMessage: async ({ space, messageId, client }) => {
      const c = client as TelegramClient;
      await unpinMessage(c.bot, space.id, messageId, c.logger);
    },
  },
});
