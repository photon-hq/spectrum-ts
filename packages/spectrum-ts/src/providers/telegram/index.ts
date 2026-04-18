// ---------------------------------------------------------------------------
// Upcoming / Future Integration Areas
// ---------------------------------------------------------------------------
// Webhook Mode
//   setWebhook, deleteWebhook, getWebhookInfo, webhook HTTP server.
//   Currently only long-polling (bot.start) is supported. Webhook mode
//   requires a dedicated server to receive updates from Telegram, proper
//   lifecycle management, and integration with the PlatformDef events system.
//   See: https://core.telegram.org/bots/webhooks
//
// Mini Apps (Web Apps)
//   Full client-side JS SDK for building embedded interfaces inside Telegram.
//   Requires: WebApp init, theme params, viewport events, haptic feedback,
//   cloud storage, biometrics, QR scanning, full-screen mode, home screen
//   shortcuts, device motion, geolocation, secure storage, share to stories.
//   See: https://core.telegram.org/bots/webapps
//
// Inline Mode
//   answerInlineQuery, savePreparedInlineMessage, InlineQueryResult builders,
//   inline feedback events. Allows users to invoke bot via @botusername query.
//   Inline edit variants (require inline_message_id from inline mode):
//     editMessageTextInline, editMessageCaptionInline, editMessageMediaInline,
//     editMessageReplyMarkupInline, editMessageLiveLocationInline,
//     stopMessageLiveLocationInline, getGameHighScoresInline, setGameScoreInline.
//   See: https://core.telegram.org/bots/inline
//
// HTML5 Games
//   sendGame, setGameScore, getGameHighScores, game callback handling.
//   See: https://core.telegram.org/bots/games
//
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

import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { Bot } from "grammy";
import type { Content } from "../../content/types";
import { definePlatform } from "../../platform/define";
import { createLogger, type TelegramLogger } from "./errors";
import {
  addStickerToSet,
  answerCallbackQuery,
  answerPreCheckoutQuery,
  answerShippingQuery,
  answerWebAppQuery,
  approveChatJoinRequest,
  approveSuggestedPost,
  banChatMember,
  banChatSenderChat,
  botClose,
  botLogOut,
  businessConnections,
  businessMessages,
  businessSend,
  callbackQueries,
  channelPosts,
  chatBoosts,
  chatJoinRequests,
  chatMemberUpdates,
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
  deletedBusinessMessages,
  deleteForumTopic,
  deleteMessage,
  deleteMessages,
  deleteMyCommands,
  deleteStickerFromSet,
  deleteStickerSet,
  deleteStory,
  editChatInviteLink,
  editChatSubscriptionInviteLink,
  editedBusinessMessages,
  editedMessages,
  editForumTopic,
  editGeneralForumTopic,
  editMessage,
  editMessageCaption,
  editMessageChecklist,
  editMessageLiveLocation,
  editMessageReplyMarkup,
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
  giftPremiumSubscription,
  hideGeneralForumTopic,
  leaveChat,
  messageReactions,
  messages,
  myChatMemberUpdates,
  pinMessage,
  pollAnswers,
  postStory,
  preCheckoutQueries,
  promoteChatMember,
  purchasedPaidMedia,
  reactToMessage,
  readBusinessMessage,
  refundStarPayment,
  removeBusinessAccountProfilePhoto,
  removedChatBoosts,
  removeMyProfilePhoto,
  reopenForumTopic,
  reopenGeneralForumTopic,
  replaceStickerInSet,
  replyToMessage,
  repostStory,
  restrictChatMember,
  revokeChatInviteLink,
  send,
  sendAnimation,
  sendChecklist,
  sendContact,
  sendDice,
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
  shippingQueries,
  startTyping,
  stopMessageLiveLocation,
  stopPoll,
  successfulPayments,
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
  type CreateInviteLinkOptions,
  type CreateInvoiceLinkParams,
  configSchema,
  type DeletedBusinessMessagesEvent,
  type EditedMessage,
  type EditInviteLinkOptions,
  type ForumTopicInfo,
  type GiftItem,
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
  type PurchasedPaidMediaEvent,
  type SendLocationParams,
  type SendPollParams,
  type ShippingOption,
  type ShippingQueryEvent,
  type StarTransaction,
  type StickerFormat,
  type StickerInfo,
  type StickerSetInfo,
  type SuccessfulPaymentEvent,
  spaceSchema,
  type UserChatBoost,
} from "./types";

interface TelegramClient {
  bot: Bot;
  logger: TelegramLogger;
  parseMode?: ParseMode;
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

      return {
        bot,
        logger,
        parseMode: config.parseMode,
      };
    },

    destroyClient: async ({ client }: { client: TelegramClient }) => {
      await client.bot.stop();
    },
  },

  events: {
    messages: ({ client }) => {
      const c = client as TelegramClient;
      return messages(c.bot, c.logger);
    },
    editedMessages: ({ client }: { client: TelegramClient }) =>
      editedMessages(client.bot) as AsyncIterable<EditedMessage>,
    channelPosts: ({ client }: { client: TelegramClient }) =>
      channelPosts(client.bot) as AsyncIterable<ChannelPost>,
    callbackQueries: ({ client }: { client: TelegramClient }) =>
      callbackQueries(client.bot) as AsyncIterable<CallbackQuery>,
    shippingQueries: ({ client }: { client: TelegramClient }) =>
      shippingQueries(client.bot) as AsyncIterable<ShippingQueryEvent>,
    preCheckoutQueries: ({ client }: { client: TelegramClient }) =>
      preCheckoutQueries(client.bot) as AsyncIterable<PreCheckoutQueryEvent>,
    successfulPayments: ({ client }: { client: TelegramClient }) =>
      successfulPayments(client.bot) as AsyncIterable<SuccessfulPaymentEvent>,
    businessConnections: ({ client }: { client: TelegramClient }) =>
      businessConnections(client.bot) as AsyncIterable<BusinessConnectionEvent>,
    businessMessages: ({ client }: { client: TelegramClient }) =>
      businessMessages(
        client.bot,
        client.logger
      ) as AsyncIterable<BusinessMessageEvent>,
    editedBusinessMessages: ({ client }: { client: TelegramClient }) =>
      editedBusinessMessages(
        client.bot,
        client.logger
      ) as AsyncIterable<BusinessMessageEvent>,
    deletedBusinessMessages: ({ client }: { client: TelegramClient }) =>
      deletedBusinessMessages(
        client.bot
      ) as AsyncIterable<DeletedBusinessMessagesEvent>,
    messageReactions: ({ client }: { client: TelegramClient }) =>
      messageReactions(client.bot) as AsyncIterable<MessageReactionEvent>,
    chatJoinRequests: ({ client }: { client: TelegramClient }) =>
      chatJoinRequests(client.bot) as AsyncIterable<ChatJoinRequestEvent>,
    myChatMemberUpdates: ({ client }: { client: TelegramClient }) =>
      myChatMemberUpdates(client.bot) as AsyncIterable<ChatMemberUpdateEvent>,
    chatMemberUpdates: ({ client }: { client: TelegramClient }) =>
      chatMemberUpdates(client.bot) as AsyncIterable<ChatMemberUpdateEvent>,
    chatBoosts: ({ client }: { client: TelegramClient }) =>
      chatBoosts(client.bot) as AsyncIterable<ChatBoostEvent>,
    removedChatBoosts: ({ client }: { client: TelegramClient }) =>
      removedChatBoosts(client.bot) as AsyncIterable<ChatBoostRemovedEvent>,
    pollAnswers: ({ client }: { client: TelegramClient }) =>
      pollAnswers(client.bot) as AsyncIterable<PollAnswerEvent>,
    purchasedPaidMedia: ({ client }: { client: TelegramClient }) =>
      purchasedPaidMedia(client.bot) as AsyncIterable<PurchasedPaidMediaEvent>,
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
