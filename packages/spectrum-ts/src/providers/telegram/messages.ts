import type {
  InlineKeyboardMarkup,
  InlineQueryResult,
  InlineQueryResultsButton,
  InputStoryContent as InputStoryContentF,
  ReactionTypeEmoji,
} from "@grammyjs/types";
import { type Bot, type Context, InputFile } from "grammy";

type InputStoryContent = InputStoryContentF<InputFile>;

import { asAttachment } from "../../content/attachment";
import { asCustom } from "../../content/custom";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import { type ManagedStream, stream } from "../../utils/stream";
import { createLogger, type TelegramLogger, withRetry } from "./errors";
import type {
  AcceptedGiftTypesConfig,
  AdminRights,
  AnswerInlineQueryOptions,
  BotCommand,
  BotInfo,
  BusinessConnectionEvent,
  BusinessMessageEvent,
  BusinessStarBalance,
  CallbackQuery,
  ChannelPost,
  ChatAdminInfo,
  ChatBoostEvent,
  ChatBoostRemovedEvent,
  ChatInfo,
  ChatInviteLinkInfo,
  ChatJoinRequestEvent,
  ChatMemberInfo,
  ChatMemberUpdateEvent,
  ChatPermissions,
  ChecklistParams,
  ChosenInlineResultEvent,
  CreateInviteLinkOptions,
  CreateInvoiceLinkParams,
  DeletedBusinessMessagesEvent,
  EditedMessage,
  EditInviteLinkOptions,
  ForumTopicInfo,
  GameHighScore,
  GetGameHighScoresOptions,
  GiftItem,
  InlineQueryEvent,
  InputStickerParams,
  InvoiceParams,
  MaskPositionParams,
  MediaGroupItem,
  MenuButtonResult,
  MessageReactionEvent,
  OwnedGiftItem,
  PaidMediaParams,
  ParseMode,
  PollAnswerEvent,
  PollInfo,
  PostStoryParams,
  PreCheckoutQueryEvent,
  PreparedInlineMessageResult,
  PurchasedPaidMediaEvent,
  SavePreparedInlineMessageOptions,
  SendLocationParams,
  SendPollParams,
  SetGameScoreOptions,
  ShippingOption,
  ShippingQueryEvent,
  StarTransaction,
  StickerFormat,
  StickerInfo,
  StickerSetInfo,
  SuccessfulPaymentEvent,
  TelegramMessage,
  UserChatBoost,
  WebhookInfo,
} from "./types";

type TgMessage = Context["message"] & {};

const fileUrl = (token: string, filePath: string): string =>
  `https://api.telegram.org/file/bot${token}/${filePath}`;

const fetchFile = async (
  bot: Bot,
  fileId: string
): Promise<{ url: string; size?: number }> => {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram returned no file_path for ${fileId}`);
  }
  return { url: fileUrl(bot.token, file.file_path), size: file.file_size };
};

const lazyMedia = (
  bot: Bot,
  fileId: string,
  name: string,
  mimeType: string
): Content =>
  asAttachment({
    name,
    mimeType,
    read: async () => {
      const { url } = await fetchFile(bot, fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Media download failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    stream: async () => {
      const { url } = await fetchFile(bot, fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Media download failed: ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Media response missing body");
      }
      return response.body;
    },
  });

const mapTextContent = (msg: TgMessage): Content | undefined => {
  if (msg.text) {
    return asText(msg.text);
  }
  if (msg.caption) {
    return asText(msg.caption);
  }
  return undefined;
};

const mapMediaContent = (bot: Bot, msg: TgMessage): Content | undefined => {
  if (msg.photo) {
    const largest = msg.photo.at(-1);
    if (largest) {
      return lazyMedia(
        bot,
        largest.file_id,
        `photo-${largest.file_id}.jpg`,
        "image/jpeg"
      );
    }
  }
  if (msg.video) {
    return lazyMedia(
      bot,
      msg.video.file_id,
      msg.video.file_name ?? `video-${msg.video.file_id}.mp4`,
      msg.video.mime_type ?? "video/mp4"
    );
  }
  if (msg.animation) {
    return lazyMedia(
      bot,
      msg.animation.file_id,
      msg.animation.file_name ?? `animation-${msg.animation.file_id}.gif`,
      msg.animation.mime_type ?? "video/mp4"
    );
  }
  if (msg.audio) {
    return lazyMedia(
      bot,
      msg.audio.file_id,
      msg.audio.file_name ?? `audio-${msg.audio.file_id}.mp3`,
      msg.audio.mime_type ?? "audio/mpeg"
    );
  }
  if (msg.document) {
    return lazyMedia(
      bot,
      msg.document.file_id,
      msg.document.file_name ?? `document-${msg.document.file_id}`,
      msg.document.mime_type ?? "application/octet-stream"
    );
  }
  if (msg.voice) {
    return lazyMedia(
      bot,
      msg.voice.file_id,
      `voice-${msg.voice.file_id}.ogg`,
      msg.voice.mime_type ?? "audio/ogg"
    );
  }
  if (msg.video_note) {
    return lazyMedia(
      bot,
      msg.video_note.file_id,
      `videonote-${msg.video_note.file_id}.mp4`,
      "video/mp4"
    );
  }
  return undefined;
};

const mapCustomContent = (msg: TgMessage): Content => {
  if (msg.sticker) {
    return asCustom({
      telegram_type: "sticker",
      file_id: msg.sticker.file_id,
      emoji: msg.sticker.emoji,
      set_name: msg.sticker.set_name,
      is_animated: msg.sticker.is_animated,
      is_video: msg.sticker.is_video,
    });
  }
  if (msg.location) {
    return asCustom({
      telegram_type: "location",
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    });
  }
  if (msg.contact) {
    return asCustom({
      telegram_type: "contact",
      phone_number: msg.contact.phone_number,
      first_name: msg.contact.first_name,
      last_name: msg.contact.last_name,
    });
  }
  if (msg.poll) {
    return asCustom({
      telegram_type: "poll",
      question: msg.poll.question,
      options: msg.poll.options,
    });
  }
  if (msg.venue) {
    return asCustom({
      telegram_type: "venue",
      title: msg.venue.title,
      address: msg.venue.address,
      latitude: msg.venue.location.latitude,
      longitude: msg.venue.location.longitude,
    });
  }
  if (msg.dice) {
    return asCustom({
      telegram_type: "dice",
      emoji: msg.dice.emoji,
      value: msg.dice.value,
    });
  }
  return asCustom({ telegram_type: "unknown" });
};

export const mapContent = (bot: Bot, msg: TgMessage): Content =>
  mapTextContent(msg) ?? mapMediaContent(bot, msg) ?? mapCustomContent(msg);

export const toMessage = (bot: Bot, msg: TgMessage): TelegramMessage => ({
  id: String(msg.message_id),
  content: mapContent(bot, msg),
  sender: { id: String(msg.from?.id ?? msg.chat.id) },
  space: { id: String(msg.chat.id), type: msg.chat.type },
  timestamp: new Date(msg.date * 1000),
});

// ---------------------------------------------------------------------------
// Helpers for extracting custom content metadata (parse_mode, reply_markup)
// ---------------------------------------------------------------------------

interface SendOptions {
  parse_mode?: ParseMode;
  // biome-ignore lint/suspicious/noExplicitAny: grammy accepts multiple reply_markup shapes
  reply_markup?: any;
}

const extractSendOptions = (
  content: Content,
  defaultParseMode?: ParseMode
): SendOptions => {
  const opts: SendOptions = {};
  if (defaultParseMode) {
    opts.parse_mode = defaultParseMode;
  }
  if (content.type === "custom" && content.raw) {
    const raw = content.raw as Record<string, unknown>;
    if (raw.parse_mode) {
      opts.parse_mode = raw.parse_mode as ParseMode;
    }
    if (raw.reply_markup) {
      opts.reply_markup = raw.reply_markup;
    }
  }
  return opts;
};

// ---------------------------------------------------------------------------
// Inbound event streams
// ---------------------------------------------------------------------------

export const messages = (
  bot: Bot,
  _logger: TelegramLogger
): ManagedStream<TelegramMessage> =>
  stream<TelegramMessage>((emit) => {
    bot.on("message", (ctx) => {
      if (ctx.message) {
        emit(toMessage(bot, ctx.message));
      }
    });
  });

export const editedMessages = (bot: Bot): ManagedStream<EditedMessage> =>
  stream<EditedMessage>((emit) => {
    bot.on("edited_message", (ctx) => {
      const msg = ctx.editedMessage;
      if (!msg) {
        return;
      }
      emit({
        id: String(msg.message_id),
        content: mapContent(bot, msg as TgMessage),
        sender: { id: String(msg.from?.id ?? msg.chat.id) },
        space: { id: String(msg.chat.id), type: msg.chat.type },
        editDate: new Date((msg.edit_date ?? msg.date) * 1000),
      });
    });
  });

export const channelPosts = (bot: Bot): ManagedStream<ChannelPost> =>
  stream<ChannelPost>((emit) => {
    bot.on("channel_post", (ctx) => {
      const post = ctx.channelPost;
      if (!post) {
        return;
      }
      emit({
        id: String(post.message_id),
        content: mapContent(bot, post as unknown as TgMessage),
        space: { id: String(post.chat.id), type: "channel" },
        timestamp: new Date(post.date * 1000),
      });
    });
  });

export const callbackQueries = (bot: Bot): ManagedStream<CallbackQuery> =>
  stream<CallbackQuery>((emit) => {
    bot.on("callback_query:data", (ctx) => {
      const query = ctx.callbackQuery;
      emit({
        id: query.id,
        messageId: query.message ? String(query.message.message_id) : undefined,
        sender: { id: String(query.from.id) },
        space: query.message
          ? {
              id: String(query.message.chat.id),
              type: query.message.chat.type,
            }
          : undefined,
        data: query.data,
      });
    });
  });

export const shippingQueries = (bot: Bot): ManagedStream<ShippingQueryEvent> =>
  stream<ShippingQueryEvent>((emit) => {
    bot.on("shipping_query", (ctx) => {
      const query = ctx.shippingQuery;
      emit({
        id: query.id,
        sender: { id: String(query.from.id) },
        invoicePayload: query.invoice_payload,
        shippingAddress: {
          countryCode: query.shipping_address.country_code,
          state: query.shipping_address.state,
          city: query.shipping_address.city,
          streetLine1: query.shipping_address.street_line1,
          streetLine2: query.shipping_address.street_line2,
          postCode: query.shipping_address.post_code,
        },
      });
    });
  });

export const preCheckoutQueries = (
  bot: Bot
): ManagedStream<PreCheckoutQueryEvent> =>
  stream<PreCheckoutQueryEvent>((emit) => {
    bot.on("pre_checkout_query", (ctx) => {
      const query = ctx.preCheckoutQuery;
      emit({
        id: query.id,
        sender: { id: String(query.from.id) },
        currency: query.currency,
        totalAmount: query.total_amount,
        invoicePayload: query.invoice_payload,
      });
    });
  });

export const successfulPayments = (
  bot: Bot
): ManagedStream<SuccessfulPaymentEvent> =>
  stream<SuccessfulPaymentEvent>((emit) => {
    bot.on("message:successful_payment", (ctx) => {
      const payment = ctx.message.successful_payment;
      emit({
        sender: { id: String(ctx.message.from?.id ?? ctx.message.chat.id) },
        space: { id: String(ctx.message.chat.id), type: ctx.message.chat.type },
        currency: payment.currency,
        totalAmount: payment.total_amount,
        invoicePayload: payment.invoice_payload,
      });
    });
  });

// ---------------------------------------------------------------------------
// Business event streams
// ---------------------------------------------------------------------------

export const businessConnections = (
  bot: Bot
): ManagedStream<BusinessConnectionEvent> =>
  stream<BusinessConnectionEvent>((emit) => {
    bot.on("business_connection", (ctx) => {
      const conn = ctx.businessConnection;
      emit({
        id: conn.id,
        userId: String(conn.user.id),
        userChatId: String(conn.user_chat_id),
        isEnabled: conn.is_enabled,
        rights: conn.rights
          ? {
              canReply: conn.rights.can_reply ?? false,
              canReadMessages: conn.rights.can_read_messages ?? false,
              canDeleteOutgoingMessages:
                conn.rights.can_delete_outgoing_messages ?? false,
              canDeleteAllMessages:
                conn.rights.can_delete_all_messages ?? false,
              canEditName: conn.rights.can_edit_name ?? false,
              canEditBio: conn.rights.can_edit_bio ?? false,
              canEditProfilePhoto: conn.rights.can_edit_profile_photo ?? false,
              canEditUsername: conn.rights.can_edit_username ?? false,
            }
          : undefined,
        date: new Date(conn.date * 1000),
      });
    });
  });

export const businessMessages = (
  bot: Bot,
  logger: TelegramLogger
): ManagedStream<BusinessMessageEvent> =>
  stream<BusinessMessageEvent>((emit) => {
    bot.on("business_message", (ctx) => {
      const msg = ctx.update.business_message;
      if (!msg) {
        return;
      }
      try {
        emit({
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
  });

export const editedBusinessMessages = (
  bot: Bot,
  logger: TelegramLogger
): ManagedStream<BusinessMessageEvent> =>
  stream<BusinessMessageEvent>((emit) => {
    bot.on("edited_business_message", (ctx) => {
      const msg = ctx.update.edited_business_message;
      if (!msg) {
        return;
      }
      try {
        emit({
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
  });

export const deletedBusinessMessages = (
  bot: Bot
): ManagedStream<DeletedBusinessMessagesEvent> =>
  stream<DeletedBusinessMessagesEvent>((emit) => {
    bot.on("deleted_business_messages", (ctx) => {
      const del = ctx.update.deleted_business_messages;
      if (!del) {
        return;
      }
      emit({
        businessConnectionId: del.business_connection_id,
        space: { id: String(del.chat.id), type: del.chat.type },
        messageIds: del.message_ids.map(String),
      });
    });
  });

// ---------------------------------------------------------------------------
// Outbound actions
// ---------------------------------------------------------------------------

export const startTyping = async (bot: Bot, spaceId: string): Promise<void> => {
  await bot.api.sendChatAction(Number(spaceId), "typing");
};

const mimeToMediaType = (
  mimeType: string
): "photo" | "video" | "audio" | "document" => {
  if (mimeType.startsWith("image/")) {
    return "photo";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "document";
};

const sendAttachment = async (
  bot: Bot,
  chatId: number,
  content: Content & { type: "attachment" },
  // biome-ignore lint/suspicious/noExplicitAny: grammy send options vary per media type
  extra?: Record<string, any>
): Promise<void> => {
  const file = new InputFile(await content.read(), content.name);
  const mediaType = mimeToMediaType(content.mimeType);
  switch (mediaType) {
    case "photo":
      await bot.api.sendPhoto(chatId, file, extra);
      break;
    case "video":
      await bot.api.sendVideo(chatId, file, extra);
      break;
    case "audio":
      await bot.api.sendAudio(chatId, file, extra);
      break;
    case "document":
      await bot.api.sendDocument(chatId, file, extra);
      break;
    default:
      break;
  }
};

export const send = async (
  bot: Bot,
  spaceId: string,
  content: Content,
  logger: TelegramLogger,
  defaultParseMode?: ParseMode
): Promise<void> => {
  const chatId = Number(spaceId);
  const opts = extractSendOptions(content, defaultParseMode);

  await withRetry(async () => {
    switch (content.type) {
      case "text":
        await bot.api.sendMessage(chatId, content.text, opts);
        break;
      case "attachment":
        await sendAttachment(bot, chatId, content, opts);
        break;
      case "custom": {
        const raw = content.raw as Record<string, unknown> | undefined;
        if (raw?.text && typeof raw.text === "string") {
          await bot.api.sendMessage(chatId, raw.text, opts);
        }
        break;
      }
      default:
        break;
    }
  }, logger);
};

export const reactToMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  reaction: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setMessageReaction(Number(spaceId), Number(messageId), [
        { type: "emoji", emoji: reaction as ReactionTypeEmoji["emoji"] },
      ]),
    logger
  );
};

export const replyToMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  content: Content,
  logger: TelegramLogger,
  defaultParseMode?: ParseMode
): Promise<void> => {
  const chatId = Number(spaceId);
  const replyParams = { message_id: Number(messageId) };
  const opts = extractSendOptions(content, defaultParseMode);
  const extra = { ...opts, reply_parameters: replyParams };

  await withRetry(async () => {
    switch (content.type) {
      case "text":
        await bot.api.sendMessage(chatId, content.text, extra);
        break;
      case "attachment":
        await sendAttachment(bot, chatId, content, extra);
        break;
      default:
        break;
    }
  }, logger);
};

export const editMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  content: Content,
  logger: TelegramLogger,
  defaultParseMode?: ParseMode
): Promise<void> => {
  const chatId = Number(spaceId);
  const msgId = Number(messageId);
  const opts = extractSendOptions(content, defaultParseMode);

  await withRetry(async () => {
    switch (content.type) {
      case "text":
        await bot.api.editMessageText(chatId, msgId, content.text, opts);
        break;
      case "attachment": {
        const file = new InputFile(await content.read(), content.name);
        const mediaType = mimeToMediaType(content.mimeType);
        await bot.api.editMessageMedia(chatId, msgId, {
          type: mediaType === "photo" ? "photo" : "document",
          media: file,
        });
        break;
      }
      default:
        break;
    }
  }, logger);
};

export const deleteMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.deleteMessage(Number(spaceId), Number(messageId)),
    logger
  );
};

// ---------------------------------------------------------------------------
// Forward, pin, copy
// ---------------------------------------------------------------------------

export const forwardMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  toSpaceId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.forwardMessage(
        Number(toSpaceId),
        Number(spaceId),
        Number(messageId)
      ),
    logger
  );
};

export const copyMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  toSpaceId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.copyMessage(
        Number(toSpaceId),
        Number(spaceId),
        Number(messageId)
      ),
    logger
  );
};

export const pinMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.pinChatMessage(Number(spaceId), Number(messageId)),
    logger
  );
};

export const unpinMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.unpinChatMessage(Number(spaceId), Number(messageId)),
    logger
  );
};

// ---------------------------------------------------------------------------
// Answer callback / payment queries
// ---------------------------------------------------------------------------

export const answerCallbackQuery = async (
  bot: Bot,
  callbackQueryId: string,
  options?: { text?: string; showAlert?: boolean; url?: string },
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.answerCallbackQuery(callbackQueryId, {
        text: options?.text,
        show_alert: options?.showAlert,
        url: options?.url,
      }),
    logger
  );
};

export const answerShippingQuery = async (
  bot: Bot,
  queryId: string,
  ok: boolean,
  shippingOptions?: ShippingOption[],
  errorMessage?: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.answerShippingQuery(queryId, ok, {
        shipping_options: shippingOptions?.map((opt) => ({
          id: opt.id,
          title: opt.title,
          prices: opt.prices.map((p) => ({
            label: p.label,
            amount: p.amount,
          })),
        })),
        error_message: errorMessage,
      }),
    logger
  );
};

export const answerPreCheckoutQuery = async (
  bot: Bot,
  queryId: string,
  ok: boolean,
  errorMessage?: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.answerPreCheckoutQuery(queryId, ok, {
        error_message: ok ? undefined : errorMessage,
      }),
    logger
  );
};

// ---------------------------------------------------------------------------
// Send invoice
// ---------------------------------------------------------------------------

export const sendInvoice = async (
  bot: Bot,
  spaceId: string,
  params: InvoiceParams,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendInvoice(
        Number(spaceId),
        params.title,
        params.description,
        params.payload,
        params.currency,
        params.prices.map((p) => ({ label: p.label, amount: p.amount })),
        {
          provider_token: params.providerToken,
          max_tip_amount: params.maxTipAmount,
          suggested_tip_amounts: params.suggestedTipAmounts,
          start_parameter: params.startParameter,
          provider_data: params.providerData,
          photo_url: params.photoUrl,
          photo_size: params.photoSize,
          photo_width: params.photoWidth,
          photo_height: params.photoHeight,
          need_name: params.needName,
          need_phone_number: params.needPhoneNumber,
          need_email: params.needEmail,
          need_shipping_address: params.needShippingAddress,
          send_phone_number_to_provider: params.sendPhoneNumberToProvider,
          send_email_to_provider: params.sendEmailToProvider,
          is_flexible: params.isFlexible,
        }
      ),
    logger
  );
};

// ---------------------------------------------------------------------------
// Bot commands
// ---------------------------------------------------------------------------

export const setMyCommands = async (
  bot: Bot,
  commands: BotCommand[],
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setMyCommands(
        commands.map((c) => ({
          command: c.command,
          description: c.description,
        }))
      ),
    logger
  );
};

export const deleteMyCommands = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.deleteMyCommands(), logger);
};

export const getMyCommands = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<BotCommand[]> => {
  return withRetry(async () => {
    const cmds = await bot.api.getMyCommands();
    return cmds.map((c) => ({
      command: c.command,
      description: c.description,
    }));
  }, logger);
};

// ---------------------------------------------------------------------------
// Chat info / member info
// ---------------------------------------------------------------------------

export const getChatInfo = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<ChatInfo> => {
  return withRetry(async () => {
    const chat = await bot.api.getChat(Number(spaceId));
    return {
      id: String(chat.id),
      type: chat.type,
      title: "title" in chat ? chat.title : undefined,
      username: "username" in chat ? (chat.username ?? undefined) : undefined,
      firstName:
        "first_name" in chat ? (chat.first_name ?? undefined) : undefined,
      lastName: "last_name" in chat ? (chat.last_name ?? undefined) : undefined,
      description:
        "description" in chat ? (chat.description ?? undefined) : undefined,
    };
  }, logger);
};

export const getChatMember = async (
  bot: Bot,
  spaceId: string,
  userId: string,
  logger: TelegramLogger = createLogger()
): Promise<ChatMemberInfo> => {
  return withRetry(async () => {
    const member = await bot.api.getChatMember(Number(spaceId), Number(userId));
    return {
      userId: String(member.user.id),
      status: member.status,
      isAnonymous: "is_anonymous" in member ? member.is_anonymous : undefined,
      customTitle:
        "custom_title" in member
          ? (member.custom_title ?? undefined)
          : undefined,
    };
  }, logger);
};

// ---------------------------------------------------------------------------
// Business mode: send on behalf of a business account
// ---------------------------------------------------------------------------

export const businessSend = async (
  bot: Bot,
  spaceId: string,
  businessConnectionId: string,
  content: Content,
  logger: TelegramLogger,
  defaultParseMode?: ParseMode
): Promise<void> => {
  const chatId = Number(spaceId);
  const opts = extractSendOptions(content, defaultParseMode);
  const extra = { ...opts, business_connection_id: businessConnectionId };

  await withRetry(async () => {
    switch (content.type) {
      case "text":
        await bot.api.sendMessage(chatId, content.text, extra);
        break;
      case "attachment":
        await sendAttachment(bot, chatId, content, extra);
        break;
      case "custom": {
        const raw = content.raw as Record<string, unknown> | undefined;
        if (raw?.text && typeof raw.text === "string") {
          await bot.api.sendMessage(chatId, raw.text, extra);
        }
        break;
      }
      default:
        break;
    }
  }, logger);
};

export const getBusinessConnection = async (
  bot: Bot,
  connectionId: string,
  logger: TelegramLogger = createLogger()
): Promise<BusinessConnectionEvent> => {
  return withRetry(async () => {
    const conn = await bot.api.getBusinessConnection(connectionId);
    return {
      id: conn.id,
      userId: String(conn.user.id),
      userChatId: String(conn.user_chat_id),
      isEnabled: conn.is_enabled,
      rights: conn.rights
        ? {
            canReply: conn.rights.can_reply ?? false,
            canReadMessages: conn.rights.can_read_messages ?? false,
            canDeleteOutgoingMessages:
              conn.rights.can_delete_outgoing_messages ?? false,
            canDeleteAllMessages: conn.rights.can_delete_all_messages ?? false,
            canEditName: conn.rights.can_edit_name ?? false,
            canEditBio: conn.rights.can_edit_bio ?? false,
            canEditProfilePhoto: conn.rights.can_edit_profile_photo ?? false,
            canEditUsername: conn.rights.can_edit_username ?? false,
          }
        : undefined,
      date: new Date(conn.date * 1000),
    };
  }, logger);
};

// ---------------------------------------------------------------------------
// Telegram Stars: create invoice link, send paid media
// ---------------------------------------------------------------------------

export const createInvoiceLink = async (
  bot: Bot,
  params: CreateInvoiceLinkParams,
  logger: TelegramLogger = createLogger()
): Promise<string> => {
  return withRetry(
    () =>
      bot.api.createInvoiceLink(
        params.title,
        params.description,
        params.payload,
        params.providerToken ?? "",
        params.currency,
        params.prices.map((p) => ({ label: p.label, amount: p.amount })),
        {
          max_tip_amount: params.maxTipAmount,
          suggested_tip_amounts: params.suggestedTipAmounts,
          provider_data: params.providerData,
          photo_url: params.photoUrl,
          photo_size: params.photoSize,
          photo_width: params.photoWidth,
          photo_height: params.photoHeight,
          subscription_period: params.subscriptionPeriod,
        }
      ),
    logger
  );
};

export const sendPaidMedia = async (
  bot: Bot,
  spaceId: string,
  params: PaidMediaParams,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendPaidMedia(
        Number(spaceId),
        params.starCount,
        params.media.map((m) => ({
          type: m.type,
          media:
            typeof m.data === "string"
              ? m.data
              : new InputFile(m.data, `paid-${m.type}`),
        })),
        {
          caption: params.caption,
          parse_mode: params.parseMode,
          payload: params.payload,
        }
      ),
    logger
  );
};

// ---------------------------------------------------------------------------
// Chat management
// ---------------------------------------------------------------------------

export const banChatMember = async (
  bot: Bot,
  spaceId: string,
  userId: string,
  logger: TelegramLogger,
  untilDate?: number
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.banChatMember(Number(spaceId), Number(userId), {
        until_date: untilDate,
      }),
    logger
  );
};

export const unbanChatMember = async (
  bot: Bot,
  spaceId: string,
  userId: string,
  logger: TelegramLogger,
  onlyIfBanned?: boolean
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.unbanChatMember(Number(spaceId), Number(userId), {
        only_if_banned: onlyIfBanned,
      }),
    logger
  );
};

const toApiPermissions = (
  p: ChatPermissions
): import("@grammyjs/types").ChatPermissions => ({
  can_send_messages: p.canSendMessages,
  can_send_audios: p.canSendAudios,
  can_send_documents: p.canSendDocuments,
  can_send_photos: p.canSendPhotos,
  can_send_videos: p.canSendVideos,
  can_send_video_notes: p.canSendVideoNotes,
  can_send_voice_notes: p.canSendVoiceNotes,
  can_send_polls: p.canSendPolls,
  can_send_other_messages: p.canSendOtherMessages,
  can_add_web_page_previews: p.canAddWebPagePreviews,
  can_change_info: p.canChangeInfo,
  can_invite_users: p.canInviteUsers,
  can_pin_messages: p.canPinMessages,
  can_manage_topics: p.canManageTopics,
});

export const restrictChatMember = async (
  bot: Bot,
  spaceId: string,
  userId: string,
  permissions: ChatPermissions,
  logger: TelegramLogger,
  untilDate?: number
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.restrictChatMember(
        Number(spaceId),
        Number(userId),
        toApiPermissions(permissions),
        { until_date: untilDate }
      ),
    logger
  );
};

export const promoteChatMember = async (
  bot: Bot,
  spaceId: string,
  userId: string,
  logger: TelegramLogger,
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
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.promoteChatMember(Number(spaceId), Number(userId), {
        can_change_info: rights?.canChangeInfo,
        can_delete_messages: rights?.canDeleteMessages,
        can_edit_messages: rights?.canEditMessages,
        can_invite_users: rights?.canInviteUsers,
        can_manage_chat: rights?.canManageChat,
        can_manage_video_chats: rights?.canManageVideoChats,
        can_pin_messages: rights?.canPinMessages,
        can_post_messages: rights?.canPostMessages,
        can_promote_members: rights?.canPromoteMembers,
        can_restrict_members: rights?.canRestrictMembers,
      }),
    logger
  );
};

export const setChatPermissions = async (
  bot: Bot,
  spaceId: string,
  permissions: ChatPermissions,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setChatPermissions(
        Number(spaceId),
        toApiPermissions(permissions)
      ),
    logger
  );
};

export const getChatAdministrators = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<ChatAdminInfo[]> => {
  return withRetry(async () => {
    const admins = await bot.api.getChatAdministrators(Number(spaceId));
    return admins.map((a) => ({
      userId: String(a.user.id),
      username: a.user.username ?? undefined,
      status: a.status,
      isAnonymous: a.is_anonymous,
      customTitle:
        "custom_title" in a ? (a.custom_title ?? undefined) : undefined,
      canBeEdited: "can_be_edited" in a ? a.can_be_edited : undefined,
      canDeleteMessages:
        "can_delete_messages" in a ? a.can_delete_messages : undefined,
      canManageChat: "can_manage_chat" in a ? a.can_manage_chat : undefined,
    }));
  }, logger);
};

export const getChatMemberCount = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<number> => {
  return withRetry(() => bot.api.getChatMemberCount(Number(spaceId)), logger);
};

export const leaveChat = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(() => bot.api.leaveChat(Number(spaceId)), logger);
};

// ---------------------------------------------------------------------------
// Invite links
// ---------------------------------------------------------------------------

export const exportChatInviteLink = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<string> => {
  return withRetry(() => bot.api.exportChatInviteLink(Number(spaceId)), logger);
};

export const createChatInviteLink = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger,
  options?: CreateInviteLinkOptions
): Promise<ChatInviteLinkInfo> => {
  return withRetry(async () => {
    const link = await bot.api.createChatInviteLink(Number(spaceId), {
      name: options?.name,
      expire_date: options?.expireDate,
      member_limit: options?.memberLimit,
      creates_join_request: options?.createsJoinRequest,
    });
    return mapInviteLink(link);
  }, logger);
};

export const createChatSubscriptionInviteLink = async (
  bot: Bot,
  spaceId: string,
  subscriptionPeriod: number,
  subscriptionPrice: number,
  logger: TelegramLogger,
  name?: string
): Promise<ChatInviteLinkInfo> => {
  return withRetry(async () => {
    const link = await bot.api.createChatSubscriptionInviteLink(
      Number(spaceId),
      subscriptionPeriod,
      subscriptionPrice,
      { name }
    );
    return mapInviteLink(link);
  }, logger);
};

export const revokeChatInviteLink = async (
  bot: Bot,
  spaceId: string,
  inviteLink: string,
  logger: TelegramLogger
): Promise<ChatInviteLinkInfo> => {
  return withRetry(async () => {
    const link = await bot.api.revokeChatInviteLink(
      Number(spaceId),
      inviteLink
    );
    return mapInviteLink(link);
  }, logger);
};

// biome-ignore lint/suspicious/noExplicitAny: grammy ChatInviteLink has many optional fields
const mapInviteLink = (link: any): ChatInviteLinkInfo => ({
  inviteLink: link.invite_link,
  isPrimary: link.is_primary,
  isRevoked: link.is_revoked,
  name: link.name ?? undefined,
  expireDate: link.expire_date ? new Date(link.expire_date * 1000) : undefined,
  memberLimit: link.member_limit ?? undefined,
  pendingJoinRequestCount: link.pending_join_request_count ?? undefined,
  createsJoinRequest: link.creates_join_request,
});

// ---------------------------------------------------------------------------
// Forum topics
// ---------------------------------------------------------------------------

export const createForumTopic = async (
  bot: Bot,
  spaceId: string,
  name: string,
  logger: TelegramLogger,
  iconColor?: number,
  iconCustomEmojiId?: string
): Promise<ForumTopicInfo> => {
  return withRetry(async () => {
    const topic = await bot.api.createForumTopic(Number(spaceId), name, {
      // biome-ignore lint/suspicious/noExplicitAny: grammy uses a narrow union for icon colors
      icon_color: iconColor as any,
      icon_custom_emoji_id: iconCustomEmojiId,
    });
    return {
      messageThreadId: topic.message_thread_id,
      name: topic.name,
      iconColor: topic.icon_color,
      iconCustomEmojiId: topic.icon_custom_emoji_id ?? undefined,
    };
  }, logger);
};

export const editForumTopic = async (
  bot: Bot,
  spaceId: string,
  messageThreadId: number,
  logger: TelegramLogger,
  name?: string,
  iconCustomEmojiId?: string
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editForumTopic(Number(spaceId), messageThreadId, {
        name,
        icon_custom_emoji_id: iconCustomEmojiId,
      }),
    logger
  );
};

export const closeForumTopic = async (
  bot: Bot,
  spaceId: string,
  messageThreadId: number,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.closeForumTopic(Number(spaceId), messageThreadId),
    logger
  );
};

export const reopenForumTopic = async (
  bot: Bot,
  spaceId: string,
  messageThreadId: number,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.reopenForumTopic(Number(spaceId), messageThreadId),
    logger
  );
};

export const deleteForumTopic = async (
  bot: Bot,
  spaceId: string,
  messageThreadId: number,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.deleteForumTopic(Number(spaceId), messageThreadId),
    logger
  );
};

// ---------------------------------------------------------------------------
// Rich content: polls, locations, contacts, venues, dice
// ---------------------------------------------------------------------------

export const sendPoll = async (
  bot: Bot,
  spaceId: string,
  params: SendPollParams,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendPoll(Number(spaceId), params.question, params.options, {
        is_anonymous: params.isAnonymous,
        type: params.type,
        allows_multiple_answers: params.allowsMultipleAnswers,
        allows_revoting: params.allowsRevoting,
        correct_option_ids: params.correctOptionIds,
        explanation: params.explanation,
        open_period: params.openPeriod,
        close_date: params.closeDate,
        is_closed: params.isClosed,
        shuffle_options: params.shuffleOptions,
        allow_adding_options: params.allowAddingOptions,
        hide_results_until_closes: params.hideResultsUntilCloses,
      }),
    logger
  );
};

export const stopPoll = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  logger: TelegramLogger
): Promise<PollInfo> => {
  return withRetry(async () => {
    const poll = await bot.api.stopPoll(Number(spaceId), Number(messageId));
    return {
      id: poll.id,
      question: poll.question,
      options: poll.options.map((o) => ({
        text: o.text,
        voterCount: o.voter_count,
      })),
      totalVoterCount: poll.total_voter_count,
      isClosed: poll.is_closed,
      type: poll.type,
    };
  }, logger);
};

export const sendLocation = async (
  bot: Bot,
  spaceId: string,
  params: SendLocationParams,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendLocation(Number(spaceId), params.latitude, params.longitude, {
        horizontal_accuracy: params.horizontalAccuracy,
        live_period: params.livePeriod,
        heading: params.heading,
        proximity_alert_radius: params.proximityAlertRadius,
      }),
    logger
  );
};

export const editMessageLiveLocation = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  latitude: number,
  longitude: number,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editMessageLiveLocation(
        Number(spaceId),
        Number(messageId),
        latitude,
        longitude
      ),
    logger
  );
};

export const stopMessageLiveLocation = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.stopMessageLiveLocation(Number(spaceId), Number(messageId)),
    logger
  );
};

export const sendContact = async (
  bot: Bot,
  spaceId: string,
  phoneNumber: string,
  firstName: string,
  logger: TelegramLogger,
  lastName?: string
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendContact(Number(spaceId), phoneNumber, firstName, {
        last_name: lastName,
      }),
    logger
  );
};

export const sendVenue = async (
  bot: Bot,
  spaceId: string,
  latitude: number,
  longitude: number,
  title: string,
  address: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendVenue(Number(spaceId), latitude, longitude, title, address),
    logger
  );
};

export const sendDice = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger,
  emoji?: string
): Promise<void> => {
  await withRetry(
    () =>
      // biome-ignore lint/suspicious/noExplicitAny: grammy dice emoji type is a narrow union
      bot.api.sendDice(Number(spaceId), (emoji ?? "🎲") as any),
    logger
  );
};

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

export const forwardMessages = async (
  bot: Bot,
  fromSpaceId: string,
  toSpaceId: string,
  messageIds: string[],
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.forwardMessages(
        Number(toSpaceId),
        Number(fromSpaceId),
        messageIds.map(Number)
      ),
    logger
  );
};

export const copyMessages = async (
  bot: Bot,
  fromSpaceId: string,
  toSpaceId: string,
  messageIds: string[],
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.copyMessages(
        Number(toSpaceId),
        Number(fromSpaceId),
        messageIds.map(Number)
      ),
    logger
  );
};

export const deleteMessages = async (
  bot: Bot,
  spaceId: string,
  messageIds: string[],
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.deleteMessages(Number(spaceId), messageIds.map(Number)),
    logger
  );
};

export const unpinAllMessages = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(() => bot.api.unpinAllChatMessages(Number(spaceId)), logger);
};

// ---------------------------------------------------------------------------
// New event streams
// ---------------------------------------------------------------------------

export const messageReactions = (
  bot: Bot
): ManagedStream<MessageReactionEvent> =>
  stream<MessageReactionEvent>((emit) => {
    bot.on("message_reaction", (ctx) => {
      const r = ctx.messageReaction;
      emit({
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
  });

export const chatJoinRequests = (
  bot: Bot
): ManagedStream<ChatJoinRequestEvent> =>
  stream<ChatJoinRequestEvent>((emit) => {
    bot.on("chat_join_request", (ctx) => {
      const req = ctx.chatJoinRequest;
      emit({
        space: { id: String(req.chat.id), type: req.chat.type },
        userId: String(req.from.id),
        date: new Date(req.date * 1000),
        bio: req.bio ?? undefined,
        inviteLink: req.invite_link?.invite_link ?? undefined,
      });
    });
  });

export const myChatMemberUpdates = (
  bot: Bot
): ManagedStream<ChatMemberUpdateEvent> =>
  stream<ChatMemberUpdateEvent>((emit) => {
    bot.on("my_chat_member", (ctx) => {
      const u = ctx.myChatMember;
      emit({
        space: { id: String(u.chat.id), type: u.chat.type },
        userId: String(u.from.id),
        date: new Date(u.date * 1000),
        oldStatus: u.old_chat_member.status,
        newStatus: u.new_chat_member.status,
      });
    });
  });

export const chatMemberUpdates = (
  bot: Bot
): ManagedStream<ChatMemberUpdateEvent> =>
  stream<ChatMemberUpdateEvent>((emit) => {
    bot.on("chat_member", (ctx) => {
      const u = ctx.chatMember;
      emit({
        space: { id: String(u.chat.id), type: u.chat.type },
        userId: String(u.from.id),
        date: new Date(u.date * 1000),
        oldStatus: u.old_chat_member.status,
        newStatus: u.new_chat_member.status,
      });
    });
  });

export const chatBoosts = (bot: Bot): ManagedStream<ChatBoostEvent> =>
  stream<ChatBoostEvent>((emit) => {
    bot.on("chat_boost", (ctx) => {
      const b = ctx.chatBoost;
      emit({
        space: { id: String(b.chat.id), type: b.chat.type },
        boostId: b.boost.boost_id,
        date: new Date(b.boost.add_date * 1000),
        expirationDate: new Date(b.boost.expiration_date * 1000),
        source: b.boost.source.source,
      });
    });
  });

export const removedChatBoosts = (
  bot: Bot
): ManagedStream<ChatBoostRemovedEvent> =>
  stream<ChatBoostRemovedEvent>((emit) => {
    bot.on("removed_chat_boost", (ctx) => {
      const b = ctx.removedChatBoost;
      emit({
        space: { id: String(b.chat.id), type: b.chat.type },
        boostId: b.boost_id,
        removeDate: new Date(b.remove_date * 1000),
        source: b.source.source,
      });
    });
  });

export const pollAnswers = (bot: Bot): ManagedStream<PollAnswerEvent> =>
  stream<PollAnswerEvent>((emit) => {
    bot.on("poll_answer", (ctx) => {
      const a = ctx.pollAnswer;
      emit({
        pollId: a.poll_id,
        userId: a.user ? String(a.user.id) : "",
        optionIds: [...a.option_ids],
      });
    });
  });

export const purchasedPaidMedia = (
  bot: Bot
): ManagedStream<PurchasedPaidMediaEvent> =>
  stream<PurchasedPaidMediaEvent>((emit) => {
    bot.on("purchased_paid_media", (ctx) => {
      const p = ctx.update.purchased_paid_media;
      if (!p) {
        return;
      }
      emit({
        userId: String(p.from.id),
        space: p.paid_media_payload
          ? { id: "", type: "private" }
          : { id: "", type: "private" },
        payload: p.paid_media_payload ?? "",
      });
    });
  });

// ---------------------------------------------------------------------------
// Inline Mode event streams
// ---------------------------------------------------------------------------

export const inlineQueries = (bot: Bot): ManagedStream<InlineQueryEvent> =>
  stream<InlineQueryEvent>((emit) => {
    bot.on("inline_query", (ctx) => {
      const iq = ctx.inlineQuery;
      emit({
        id: iq.id,
        from: { id: String(iq.from.id) },
        query: iq.query,
        offset: iq.offset,
        chatType: iq.chat_type,
        location: iq.location
          ? {
              latitude: iq.location.latitude,
              longitude: iq.location.longitude,
            }
          : undefined,
      });
    });
  });

export const chosenInlineResults = (
  bot: Bot
): ManagedStream<ChosenInlineResultEvent> =>
  stream<ChosenInlineResultEvent>((emit) => {
    bot.on("chosen_inline_result", (ctx) => {
      const r = ctx.chosenInlineResult;
      emit({
        resultId: r.result_id,
        from: { id: String(r.from.id) },
        query: r.query,
        inlineMessageId: r.inline_message_id,
        location: r.location
          ? { latitude: r.location.latitude, longitude: r.location.longitude }
          : undefined,
      });
    });
  });

// ---------------------------------------------------------------------------
// Inline Mode methods
// ---------------------------------------------------------------------------

export const answerInlineQuery = async (
  bot: Bot,
  inlineQueryId: string,
  results: InlineQueryResult[],
  options?: AnswerInlineQueryOptions,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.answerInlineQuery(inlineQueryId, results, {
        cache_time: options?.cacheTime,
        is_personal: options?.isPersonal,
        next_offset: options?.nextOffset,
        button: options?.button
          ? ({
              text: options.button.text,
              start_parameter: options.button.startParameter,
              web_app: options.button.webAppUrl
                ? { url: options.button.webAppUrl }
                : undefined,
            } as InlineQueryResultsButton)
          : undefined,
      }),
    logger
  );
};

export const savePreparedInlineMessage = async (
  bot: Bot,
  userId: string,
  result: InlineQueryResult,
  options?: SavePreparedInlineMessageOptions,
  logger: TelegramLogger = createLogger()
): Promise<PreparedInlineMessageResult> => {
  return withRetry(async () => {
    const msg = await bot.api.savePreparedInlineMessage(
      Number(userId),
      result,
      {
        allow_user_chats: options?.allowUserChats,
        allow_bot_chats: options?.allowBotChats,
        allow_group_chats: options?.allowGroupChats,
        allow_channel_chats: options?.allowChannelChats,
      }
    );
    return {
      id: msg.id,
      expirationDate: new Date(msg.expiration_date * 1000),
    };
  }, logger);
};

// ---------------------------------------------------------------------------
// Inline Mode edit variants (require inline_message_id)
// ---------------------------------------------------------------------------

export const editMessageTextInline = async (
  bot: Bot,
  inlineMessageId: string,
  text: string,
  options?: { parseMode?: ParseMode },
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editMessageTextInline(inlineMessageId, text, {
        parse_mode: options?.parseMode,
      }),
    logger
  );
};

export const editMessageCaptionInline = async (
  bot: Bot,
  inlineMessageId: string,
  caption: string,
  options?: { parseMode?: ParseMode },
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editMessageCaptionInline(inlineMessageId, {
        caption,
        parse_mode: options?.parseMode,
      }),
    logger
  );
};

export const editMessageReplyMarkupInline = async (
  bot: Bot,
  inlineMessageId: string,
  replyMarkup?: InlineKeyboardMarkup,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editMessageReplyMarkupInline(inlineMessageId, {
        reply_markup: replyMarkup,
      }),
    logger
  );
};

export const editMessageLiveLocationInline = async (
  bot: Bot,
  inlineMessageId: string,
  latitude: number,
  longitude: number,
  options?: {
    heading?: number;
    horizontalAccuracy?: number;
    proximityAlertRadius?: number;
  },
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editMessageLiveLocationInline(
        inlineMessageId,
        latitude,
        longitude,
        {
          heading: options?.heading,
          horizontal_accuracy: options?.horizontalAccuracy,
          proximity_alert_radius: options?.proximityAlertRadius,
        }
      ),
    logger
  );
};

export const stopMessageLiveLocationInline = async (
  bot: Bot,
  inlineMessageId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.stopMessageLiveLocationInline(inlineMessageId),
    logger
  );
};

// ---------------------------------------------------------------------------
// HTML5 Games
// ---------------------------------------------------------------------------

export const sendGame = async (
  bot: Bot,
  chatId: string,
  gameShortName: string,
  options?: {
    disableNotification?: boolean;
    protectContent?: boolean;
    replyMarkup?: InlineKeyboardMarkup;
  },
  logger: TelegramLogger = createLogger()
): Promise<string> => {
  return withRetry(async () => {
    const msg = await bot.api.sendGame(Number(chatId), gameShortName, {
      disable_notification: options?.disableNotification,
      protect_content: options?.protectContent,
      reply_markup: options?.replyMarkup,
    });
    return String(msg.message_id);
  }, logger);
};

export const setGameScore = async (
  bot: Bot,
  userId: string,
  score: number,
  options?: SetGameScoreOptions,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const uid = Number(userId);
  const other = {
    force: options?.force,
    disable_edit_message: options?.disableEditMessage,
  };
  const inlineMsgId = options?.inlineMessageId;
  if (inlineMsgId) {
    await withRetry(
      () => bot.api.setGameScoreInline(inlineMsgId, uid, score, other),
      logger
    );
  } else {
    await withRetry(
      () =>
        bot.api.setGameScore(
          options?.chatId ?? 0,
          options?.messageId ?? 0,
          uid,
          score,
          other
        ),
      logger
    );
  }
};

export const getGameHighScores = async (
  bot: Bot,
  userId: string,
  options?: GetGameHighScoresOptions,
  logger: TelegramLogger = createLogger()
): Promise<GameHighScore[]> => {
  const uid = Number(userId);
  return withRetry(async () => {
    const scores = options?.inlineMessageId
      ? await bot.api.getGameHighScoresInline(options.inlineMessageId, uid)
      : await bot.api.getGameHighScores(
          options?.chatId ?? 0,
          options?.messageId ?? 0,
          uid
        );
    return scores.map((s) => ({
      position: s.position,
      score: s.score,
      user: { id: String(s.user.id) },
    }));
  }, logger);
};

// ---------------------------------------------------------------------------
// Join request management
// ---------------------------------------------------------------------------

export const approveChatJoinRequest = async (
  bot: Bot,
  spaceId: string,
  userId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.approveChatJoinRequest(Number(spaceId), Number(userId)),
    logger
  );
};

export const declineChatJoinRequest = async (
  bot: Bot,
  spaceId: string,
  userId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.declineChatJoinRequest(Number(spaceId), Number(userId)),
    logger
  );
};

// ---------------------------------------------------------------------------
// Bot profile
// ---------------------------------------------------------------------------

export const setMyName = async (
  bot: Bot,
  name: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(() => bot.api.setMyName(name), logger);
};

export const setMyDescription = async (
  bot: Bot,
  description: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(() => bot.api.setMyDescription(description), logger);
};

export const setMyShortDescription = async (
  bot: Bot,
  shortDescription: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.setMyShortDescription(shortDescription),
    logger
  );
};

export const setChatMenuButton = async (
  bot: Bot,
  logger: TelegramLogger,
  chatId?: string,
  menuButton?:
    | { type: "commands" | "default" }
    | { type: "web_app"; text: string; webAppUrl: string }
): Promise<void> => {
  // biome-ignore lint/suspicious/noExplicitAny: grammy MenuButton is a union type
  let button: any;
  if (menuButton) {
    if (menuButton.type === "web_app") {
      button = {
        type: "web_app",
        text: menuButton.text,
        web_app: { url: menuButton.webAppUrl },
      };
    } else {
      button = { type: menuButton.type };
    }
  }
  await withRetry(
    () =>
      bot.api.setChatMenuButton({
        chat_id: chatId ? Number(chatId) : undefined,
        menu_button: button,
      }),
    logger
  );
};

export const getUserProfilePhotos = async (
  bot: Bot,
  userId: string,
  logger: TelegramLogger = createLogger()
): Promise<string[]> => {
  return withRetry(async () => {
    const photos = await bot.api.getUserProfilePhotos(Number(userId));
    const fileIds: string[] = [];
    for (const row of photos.photos) {
      const largest = row.at(-1);
      if (largest) {
        fileIds.push(largest.file_id);
      }
    }
    return fileIds;
  }, logger);
};

// ---------------------------------------------------------------------------
// Stars & monetization
// ---------------------------------------------------------------------------

export const getMyStarBalance = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<number> => {
  return withRetry(async () => {
    const balance = await bot.api.getMyStarBalance();
    return balance.amount;
  }, logger);
};

export const getStarTransactions = async (
  bot: Bot,
  logger: TelegramLogger = createLogger(),
  offset?: number,
  limit?: number
): Promise<StarTransaction[]> => {
  return withRetry(async () => {
    const result = await bot.api.getStarTransactions({ offset, limit });
    return result.transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      date: new Date(t.date * 1000),
    }));
  }, logger);
};

export const refundStarPayment = async (
  bot: Bot,
  userId: string,
  telegramPaymentChargeId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.refundStarPayment(Number(userId), telegramPaymentChargeId),
    logger
  );
};

export const sendGift = async (
  bot: Bot,
  userId: string,
  giftId: string,
  logger: TelegramLogger,
  text?: string
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendGift(Number(userId), giftId, {
        text,
      }),
    logger
  );
};

// ---------------------------------------------------------------------------
// Business account management
// ---------------------------------------------------------------------------

export const setBusinessAccountName = async (
  bot: Bot,
  connectionId: string,
  firstName: string,
  logger: TelegramLogger,
  lastName?: string
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setBusinessAccountName(connectionId, firstName, {
        last_name: lastName,
      }),
    logger
  );
};

export const setBusinessAccountBio = async (
  bot: Bot,
  connectionId: string,
  bio: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.setBusinessAccountBio(connectionId, bio),
    logger
  );
};

export const readBusinessMessage = async (
  bot: Bot,
  connectionId: string,
  chatId: string,
  messageId: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.readBusinessMessage(
        connectionId,
        Number(chatId),
        Number(messageId)
      ),
    logger
  );
};

export const deleteBusinessMessages = async (
  bot: Bot,
  connectionId: string,
  messageIds: string[],
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.deleteBusinessMessages(connectionId, messageIds.map(Number)),
    logger
  );
};

export const getBusinessAccountStarBalance = async (
  bot: Bot,
  connectionId: string,
  logger: TelegramLogger = createLogger()
): Promise<BusinessStarBalance> => {
  return withRetry(async () => {
    const balance = await bot.api.getBusinessAccountStarBalance(connectionId);
    return { amount: balance.amount };
  }, logger);
};

export const transferBusinessAccountStars = async (
  bot: Bot,
  connectionId: string,
  starCount: number,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () => bot.api.transferBusinessAccountStars(connectionId, starCount),
    logger
  );
};

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const deleteStory = async (
  bot: Bot,
  connectionId: string,
  storyId: number,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(() => bot.api.deleteStory(connectionId, storyId), logger);
};

// ---------------------------------------------------------------------------
// Media Groups (Albums)
// ---------------------------------------------------------------------------

export const sendMediaGroup = async (
  bot: Bot,
  spaceId: string,
  items: MediaGroupItem[],
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  const media = items.map((item) => {
    const file =
      typeof item.data === "string" ? item.data : new InputFile(item.data);
    return {
      type: item.type,
      media: file,
      caption: item.caption,
      parse_mode: item.parseMode,
    } as unknown as Parameters<typeof bot.api.sendMediaGroup>[1][number];
  });

  await withRetry(() => bot.api.sendMediaGroup(chatId, media), logger);
};

// ---------------------------------------------------------------------------
// Edit Caption / Reply Markup
// ---------------------------------------------------------------------------

export const editMessageCaption = async (
  bot: Bot,
  spaceId: string,
  messageId: number,
  caption: string,
  parseMode?: ParseMode,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () =>
      bot.api.editMessageCaption(chatId, messageId, {
        caption,
        parse_mode: parseMode,
      }),
    logger
  );
};

export const editMessageReplyMarkup = async (
  bot: Bot,
  spaceId: string,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () =>
      bot.api.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: replyMarkup,
      }),
    logger
  );
};

// ---------------------------------------------------------------------------
// Chat Metadata
// ---------------------------------------------------------------------------

export const setChatTitle = async (
  bot: Bot,
  spaceId: string,
  title: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.setChatTitle(chatId, title), logger);
};

export const setChatDescription = async (
  bot: Bot,
  spaceId: string,
  description: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () => bot.api.setChatDescription(chatId, description),
    logger
  );
};

export const setChatPhoto = async (
  bot: Bot,
  spaceId: string,
  photo: Buffer | string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  const file =
    typeof photo === "string"
      ? new InputFile(new URL(photo))
      : new InputFile(photo);
  await withRetry(() => bot.api.setChatPhoto(chatId, file), logger);
};

export const deleteChatPhoto = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.deleteChatPhoto(chatId), logger);
};

export const setChatAdministratorCustomTitle = async (
  bot: Bot,
  spaceId: string,
  userId: number,
  customTitle: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () => bot.api.setChatAdministratorCustomTitle(chatId, userId, customTitle),
    logger
  );
};

// ---------------------------------------------------------------------------
// Edit Invite Links
// ---------------------------------------------------------------------------

export const editChatInviteLink = async (
  bot: Bot,
  spaceId: string,
  inviteLink: string,
  options?: EditInviteLinkOptions,
  logger: TelegramLogger = createLogger()
): Promise<ChatInviteLinkInfo> => {
  const chatId = Number(spaceId);
  return withRetry(async () => {
    const link = await bot.api.editChatInviteLink(chatId, inviteLink, {
      name: options?.name,
      expire_date: options?.expireDate,
      member_limit: options?.memberLimit,
      creates_join_request: options?.createsJoinRequest,
    });
    return {
      inviteLink: link.invite_link,
      isPrimary: link.is_primary,
      isRevoked: link.is_revoked,
      expireDate: link.expire_date
        ? new Date(link.expire_date * 1000)
        : undefined,
      memberLimit: link.member_limit,
      pendingJoinRequestCount: link.pending_join_request_count,
    };
  }, logger);
};

export const editChatSubscriptionInviteLink = async (
  bot: Bot,
  spaceId: string,
  inviteLink: string,
  name?: string,
  logger: TelegramLogger = createLogger()
): Promise<ChatInviteLinkInfo> => {
  const chatId = Number(spaceId);
  return withRetry(async () => {
    const link = await bot.api.editChatSubscriptionInviteLink(
      chatId,
      inviteLink,
      { name }
    );
    return {
      inviteLink: link.invite_link,
      isPrimary: link.is_primary,
      isRevoked: link.is_revoked,
      expireDate: link.expire_date
        ? new Date(link.expire_date * 1000)
        : undefined,
      memberLimit: link.member_limit,
      pendingJoinRequestCount: link.pending_join_request_count,
    };
  }, logger);
};

// ---------------------------------------------------------------------------
// Stories (post & edit, complementing existing deleteStory)
// ---------------------------------------------------------------------------

export const postStory = async (
  bot: Bot,
  connectionId: string,
  params: PostStoryParams,
  logger: TelegramLogger = createLogger()
): Promise<{ id: number }> => {
  const file =
    typeof params.data === "string"
      ? new InputFile(new URL(params.data))
      : new InputFile(params.data);

  const content: InputStoryContent =
    params.type === "photo"
      ? { type: "photo", photo: file }
      : { type: "video", video: file };

  return withRetry(async () => {
    const story = await bot.api.postStory(
      connectionId,
      content,
      params.activePeriod,
      {
        caption: params.caption,
        parse_mode: params.parseMode,
      }
    );
    return { id: story.id };
  }, logger);
};

export const editStory = async (
  bot: Bot,
  connectionId: string,
  storyId: number,
  params: PostStoryParams,
  logger: TelegramLogger = createLogger()
): Promise<{ id: number }> => {
  const file =
    typeof params.data === "string"
      ? new InputFile(new URL(params.data))
      : new InputFile(params.data);

  const storyContent: InputStoryContent =
    params.type === "video"
      ? { type: "video", video: file }
      : { type: "photo", photo: file };

  return withRetry(async () => {
    const story = await bot.api.editStory(connectionId, storyId, storyContent, {
      caption: params.caption,
      parse_mode: params.parseMode,
    });
    return { id: story.id };
  }, logger);
};

// ---------------------------------------------------------------------------
// General Forum Topic
// ---------------------------------------------------------------------------

export const editGeneralForumTopic = async (
  bot: Bot,
  spaceId: string,
  name: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.editGeneralForumTopic(chatId, name), logger);
};

export const closeGeneralForumTopic = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.closeGeneralForumTopic(chatId), logger);
};

export const reopenGeneralForumTopic = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.reopenGeneralForumTopic(chatId), logger);
};

export const hideGeneralForumTopic = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.hideGeneralForumTopic(chatId), logger);
};

export const unhideGeneralForumTopic = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.unhideGeneralForumTopic(chatId), logger);
};

export const unpinAllForumTopicMessages = async (
  bot: Bot,
  spaceId: string,
  messageThreadId: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () => bot.api.unpinAllForumTopicMessages(chatId, messageThreadId),
    logger
  );
};

export const unpinAllGeneralForumTopicMessages = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () => bot.api.unpinAllGeneralForumTopicMessages(chatId),
    logger
  );
};

// ---------------------------------------------------------------------------
// Sticker
// ---------------------------------------------------------------------------

export const sendSticker = async (
  bot: Bot,
  spaceId: string,
  sticker: Buffer | string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  const file = typeof sticker === "string" ? sticker : new InputFile(sticker);
  await withRetry(() => bot.api.sendSticker(chatId, file), logger);
};

// ---------------------------------------------------------------------------
// Additional media senders
// ---------------------------------------------------------------------------

export const sendAnimation = async (
  bot: Bot,
  spaceId: string,
  animation: Buffer | string,
  caption?: string,
  parseMode?: ParseMode,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  const file =
    typeof animation === "string" ? animation : new InputFile(animation);
  await withRetry(
    () =>
      bot.api.sendAnimation(chatId, file, { caption, parse_mode: parseMode }),
    logger
  );
};

export const sendVoice = async (
  bot: Bot,
  spaceId: string,
  voice: Buffer | string,
  caption?: string,
  parseMode?: ParseMode,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  const file = typeof voice === "string" ? voice : new InputFile(voice);
  await withRetry(
    () => bot.api.sendVoice(chatId, file, { caption, parse_mode: parseMode }),
    logger
  );
};

export const sendVideoNote = async (
  bot: Bot,
  spaceId: string,
  videoNote: Buffer | string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  const file =
    typeof videoNote === "string" ? videoNote : new InputFile(videoNote);
  await withRetry(() => bot.api.sendVideoNote(chatId, file), logger);
};

// ---------------------------------------------------------------------------
// Bot identity
// ---------------------------------------------------------------------------

export const getMe = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<BotInfo> => {
  return withRetry(async () => {
    const me = await bot.api.getMe();
    return {
      id: me.id,
      isBot: me.is_bot as true,
      firstName: me.first_name,
      username: me.username,
      canJoinGroups: me.can_join_groups,
      canReadAllGroupMessages: me.can_read_all_group_messages,
      canManageBots: me.can_manage_bots,
      supportsInlineQueries: me.supports_inline_queries,
    };
  }, logger);
};

export const botLogOut = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.logOut(), logger);
};

export const botClose = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.close(), logger);
};

// ---------------------------------------------------------------------------
// Bot profile getters
// ---------------------------------------------------------------------------

export const getMyName = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<string> => {
  return withRetry(async () => {
    const result = await bot.api.getMyName();
    return result.name;
  }, logger);
};

export const getMyDescription = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<string> => {
  return withRetry(async () => {
    const result = await bot.api.getMyDescription();
    return result.description;
  }, logger);
};

export const getMyShortDescription = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<string> => {
  return withRetry(async () => {
    const result = await bot.api.getMyShortDescription();
    return result.short_description;
  }, logger);
};

export const getChatMenuButton = async (
  bot: Bot,
  chatId?: string,
  logger: TelegramLogger = createLogger()
): Promise<MenuButtonResult> => {
  return withRetry(async () => {
    const opts = chatId ? { chat_id: Number(chatId) } : {};
    const btn = await bot.api.getChatMenuButton(opts);
    if (btn.type === "web_app") {
      return { type: "web_app", text: btn.text, webAppUrl: btn.web_app.url };
    }
    return { type: btn.type };
  }, logger);
};

// ---------------------------------------------------------------------------
// Default administrator rights
// ---------------------------------------------------------------------------

export const setMyDefaultAdministratorRights = async (
  bot: Bot,
  rights?: AdminRights,
  forChannels?: boolean,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setMyDefaultAdministratorRights({
        rights: rights
          ? {
              is_anonymous: rights.isAnonymous,
              can_manage_chat: rights.canManageChat,
              can_delete_messages: rights.canDeleteMessages,
              can_manage_video_chats: rights.canManageVideoChats,
              can_restrict_members: rights.canRestrictMembers,
              can_promote_members: rights.canPromoteMembers,
              can_change_info: rights.canChangeInfo,
              can_invite_users: rights.canInviteUsers,
              can_post_stories: rights.canPostStories,
              can_edit_stories: rights.canEditStories,
              can_delete_stories: rights.canDeleteStories,
              can_post_messages: rights.canPostMessages,
              can_edit_messages: rights.canEditMessages,
              can_pin_messages: rights.canPinMessages,
            }
          : undefined,
        for_channels: forChannels,
      }),
    logger
  );
};

export const getMyDefaultAdministratorRights = async (
  bot: Bot,
  forChannels?: boolean,
  logger: TelegramLogger = createLogger()
): Promise<AdminRights> => {
  return withRetry(async () => {
    const r = await bot.api.getMyDefaultAdministratorRights({
      for_channels: forChannels,
    });
    return {
      isAnonymous: r.is_anonymous,
      canManageChat: r.can_manage_chat,
      canDeleteMessages: r.can_delete_messages,
      canManageVideoChats: r.can_manage_video_chats,
      canRestrictMembers: r.can_restrict_members,
      canPromoteMembers: r.can_promote_members,
      canChangeInfo: r.can_change_info,
      canInviteUsers: r.can_invite_users,
      canPostStories: r.can_post_stories,
      canEditStories: r.can_edit_stories,
      canDeleteStories: r.can_delete_stories,
      canPostMessages: r.can_post_messages,
      canEditMessages: r.can_edit_messages,
      canPinMessages: r.can_pin_messages,
      canManageTags: r.can_manage_tags,
    };
  }, logger);
};

// ---------------------------------------------------------------------------
// Channel ban + boosts + member tags
// ---------------------------------------------------------------------------

export const banChatSenderChat = async (
  bot: Bot,
  spaceId: string,
  senderChatId: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () => bot.api.banChatSenderChat(chatId, senderChatId),
    logger
  );
};

export const unbanChatSenderChat = async (
  bot: Bot,
  spaceId: string,
  senderChatId: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () => bot.api.unbanChatSenderChat(chatId, senderChatId),
    logger
  );
};

export const getUserChatBoosts = async (
  bot: Bot,
  spaceId: string,
  userId: number,
  logger: TelegramLogger = createLogger()
): Promise<UserChatBoost[]> => {
  const chatId = Number(spaceId);
  return withRetry(async () => {
    const result = await bot.api.getUserChatBoosts(chatId, userId);
    return result.boosts.map((b) => ({
      boostId: b.boost_id,
      addDate: new Date(b.add_date * 1000),
      expirationDate: new Date(b.expiration_date * 1000),
      source: b.source.source,
    }));
  }, logger);
};

export const setChatMemberTag = async (
  bot: Bot,
  spaceId: string,
  userId: number,
  tag: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.setChatMemberTag(chatId, userId, tag), logger);
};

// ---------------------------------------------------------------------------
// Webhook management
// ---------------------------------------------------------------------------

export const setWebhookApi = async (
  bot: Bot,
  url: string,
  options?: {
    certificate?: Buffer;
    dropPendingUpdates?: boolean;
    ipAddress?: string;
    maxConnections?: number;
    secretToken?: string;
  },
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setWebhook(url, {
        certificate: options?.certificate
          ? new InputFile(options.certificate)
          : undefined,
        ip_address: options?.ipAddress,
        max_connections: options?.maxConnections,
        drop_pending_updates: options?.dropPendingUpdates,
        secret_token: options?.secretToken,
      }),
    logger
  );
};

export const deleteWebhookApi = async (
  bot: Bot,
  dropPendingUpdates?: boolean,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.deleteWebhook({
        drop_pending_updates: dropPendingUpdates,
      }),
    logger
  );
};

export const getWebhookInfoApi = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<WebhookInfo> => {
  return withRetry(async () => {
    const info = await bot.api.getWebhookInfo();
    return {
      url: info.url,
      hasCustomCertificate: info.has_custom_certificate,
      pendingUpdateCount: info.pending_update_count,
      ipAddress: info.ip_address,
      maxConnections: info.max_connections,
      lastErrorDate: info.last_error_date
        ? new Date(info.last_error_date * 1000)
        : undefined,
      lastErrorMessage: info.last_error_message,
      lastSynchronizationErrorDate: info.last_synchronization_error_date
        ? new Date(info.last_synchronization_error_date * 1000)
        : undefined,
    };
  }, logger);
};

// ---------------------------------------------------------------------------
// Gifts
// ---------------------------------------------------------------------------

export const getAvailableGifts = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<GiftItem[]> => {
  return withRetry(async () => {
    const result = await bot.api.getAvailableGifts();
    return result.gifts.map((g) => ({
      id: g.id,
      starCount: g.star_count,
      totalCount: g.total_count,
      remainingCount: g.remaining_count,
    }));
  }, logger);
};

export const getUserGifts = async (
  bot: Bot,
  userId: number,
  logger: TelegramLogger = createLogger()
): Promise<OwnedGiftItem[]> => {
  return withRetry(async () => {
    const result = await bot.api.getUserGifts(userId);
    return result.gifts.map((g) => {
      const base: OwnedGiftItem = { giftId: "", ownedGiftId: undefined };
      if ("gift" in g) {
        const gift = g.gift;
        base.giftId = "id" in gift ? gift.id : gift.gift_id;
      }
      if ("owned_gift_id" in g) {
        base.ownedGiftId = g.owned_gift_id as string;
      }
      if ("sender_user" in g && g.sender_user) {
        base.senderId = String(g.sender_user.id);
      }
      if ("send_date" in g && typeof g.send_date === "number") {
        base.sentDate = new Date(g.send_date * 1000);
      }
      return base;
    });
  }, logger);
};

export const getChatGifts = async (
  bot: Bot,
  chatId: number,
  logger: TelegramLogger = createLogger()
): Promise<OwnedGiftItem[]> => {
  return withRetry(async () => {
    const result = await bot.api.getChatGifts(chatId);
    return result.gifts.map((g) => {
      const base: OwnedGiftItem = { giftId: "", ownedGiftId: undefined };
      if ("gift" in g) {
        const gift = g.gift;
        base.giftId = "id" in gift ? gift.id : gift.gift_id;
      }
      if ("owned_gift_id" in g) {
        base.ownedGiftId = g.owned_gift_id as string;
      }
      return base;
    });
  }, logger);
};

export const sendGiftToChannel = async (
  bot: Bot,
  chatId: string,
  giftId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.sendGiftToChannel(Number(chatId), giftId),
    logger
  );
};

export const transferGift = async (
  bot: Bot,
  connectionId: string,
  ownedGiftId: string,
  newOwnerChatId: number,
  starCount: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.transferGift(
        connectionId,
        ownedGiftId,
        newOwnerChatId,
        starCount
      ),
    logger
  );
};

export const upgradeGift = async (
  bot: Bot,
  connectionId: string,
  ownedGiftId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.upgradeGift(connectionId, ownedGiftId, {}),
    logger
  );
};

export const convertGiftToStars = async (
  bot: Bot,
  connectionId: string,
  ownedGiftId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.convertGiftToStars(connectionId, ownedGiftId),
    logger
  );
};

export const giftPremiumSubscription = async (
  bot: Bot,
  userId: number,
  monthCount: 3 | 6 | 12,
  starCount: 1000 | 1500 | 2500,
  text?: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.giftPremiumSubscription(userId, monthCount, starCount, {
        text,
      }),
    logger
  );
};

// ---------------------------------------------------------------------------
// Extended business account management
// ---------------------------------------------------------------------------

export const repostStory = async (
  bot: Bot,
  connectionId: string,
  fromChatId: number,
  fromStoryId: number,
  activePeriod: number,
  logger: TelegramLogger = createLogger()
): Promise<{ id: number }> => {
  return withRetry(async () => {
    const story = await bot.api.repostStory(
      connectionId,
      fromChatId,
      fromStoryId,
      activePeriod,
      {}
    );
    return { id: story.id };
  }, logger);
};

export const setBusinessAccountProfilePhoto = async (
  bot: Bot,
  connectionId: string,
  photoData: Buffer,
  isPublic?: boolean,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setBusinessAccountProfilePhoto(
        connectionId,
        { type: "static", photo: new InputFile(photoData) },
        { is_public: isPublic }
      ),
    logger
  );
};

export const removeBusinessAccountProfilePhoto = async (
  bot: Bot,
  connectionId: string,
  isPublic?: boolean,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.removeBusinessAccountProfilePhoto(connectionId, {
        is_public: isPublic,
      }),
    logger
  );
};

export const setBusinessAccountUsername = async (
  bot: Bot,
  connectionId: string,
  username: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.setBusinessAccountUsername(connectionId, username),
    logger
  );
};

export const setBusinessAccountGiftSettings = async (
  bot: Bot,
  connectionId: string,
  showGiftButton: boolean,
  acceptedTypes: AcceptedGiftTypesConfig,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setBusinessAccountGiftSettings(connectionId, showGiftButton, {
        unlimited_gifts: acceptedTypes.unlimitedGifts,
        limited_gifts: acceptedTypes.limitedGifts,
        unique_gifts: acceptedTypes.uniqueGifts,
        premium_subscription: acceptedTypes.premiumSubscription,
        gifts_from_channels: acceptedTypes.giftsFromChannels,
      }),
    logger
  );
};

export const getBusinessAccountGifts = async (
  bot: Bot,
  connectionId: string,
  logger: TelegramLogger = createLogger()
): Promise<OwnedGiftItem[]> => {
  return withRetry(async () => {
    const result = await bot.api.getBusinessAccountGifts(connectionId, {});
    return result.gifts.map((g) => {
      const base: OwnedGiftItem = { giftId: "", ownedGiftId: undefined };
      if ("gift" in g) {
        const gift = g.gift;
        base.giftId = "id" in gift ? gift.id : gift.gift_id;
      }
      if ("owned_gift_id" in g) {
        base.ownedGiftId = g.owned_gift_id as string;
      }
      return base;
    });
  }, logger);
};

// ---------------------------------------------------------------------------
// Profile photo management
// ---------------------------------------------------------------------------

export const setMyProfilePhoto = async (
  bot: Bot,
  photoData: Buffer,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setMyProfilePhoto({
        type: "static",
        photo: new InputFile(photoData),
      }),
    logger
  );
};

export const removeMyProfilePhoto = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.removeMyProfilePhoto(), logger);
};

export const getUserProfileAudios = async (
  bot: Bot,
  userId: number,
  logger: TelegramLogger = createLogger()
): Promise<number> => {
  return withRetry(async () => {
    const result = await bot.api.getUserProfileAudios(userId);
    return result.total_count;
  }, logger);
};

export const setUserEmojiStatus = async (
  bot: Bot,
  userId: number,
  emojiStatusCustomEmojiId?: string,
  emojiStatusExpirationDate?: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setUserEmojiStatus(userId, {
        emoji_status_custom_emoji_id: emojiStatusCustomEmojiId,
        emoji_status_expiration_date: emojiStatusExpirationDate,
      }),
    logger
  );
};

// ---------------------------------------------------------------------------
// Star subscriptions
// ---------------------------------------------------------------------------

export const editUserStarSubscription = async (
  bot: Bot,
  userId: number,
  telegramPaymentChargeId: string,
  isCanceled: boolean,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editUserStarSubscription(
        userId,
        telegramPaymentChargeId,
        isCanceled
      ),
    logger
  );
};

// ---------------------------------------------------------------------------
// Checklists (business)
// ---------------------------------------------------------------------------

export const sendChecklist = async (
  bot: Bot,
  connectionId: string,
  chatId: number,
  checklist: ChecklistParams,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.sendChecklist(connectionId, chatId, {
        title: checklist.title,
        parse_mode: checklist.parseMode,
        tasks: checklist.tasks.map((t) => ({
          id: t.id,
          text: t.text,
          parse_mode: t.parseMode,
        })),
        others_can_add_tasks: checklist.othersCanAddTasks,
        others_can_mark_tasks_as_done: checklist.othersCanMarkTasksAsDone
          ? true
          : undefined,
      }),
    logger
  );
};

export const editMessageChecklist = async (
  bot: Bot,
  connectionId: string,
  chatId: number,
  messageId: number,
  checklist: ChecklistParams,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.editMessageChecklist(connectionId, chatId, messageId, {
        title: checklist.title,
        parse_mode: checklist.parseMode,
        tasks: checklist.tasks.map((t) => ({
          id: t.id,
          text: t.text,
          parse_mode: t.parseMode,
        })),
        others_can_add_tasks: checklist.othersCanAddTasks,
        others_can_mark_tasks_as_done: checklist.othersCanMarkTasksAsDone
          ? true
          : undefined,
      }),
    logger
  );
};

// ---------------------------------------------------------------------------
// Web app queries
// ---------------------------------------------------------------------------

export const answerWebAppQuery = async (
  bot: Bot,
  webAppQueryId: string,
  result: Record<string, unknown>,
  logger: TelegramLogger = createLogger()
): Promise<string | undefined> => {
  return withRetry(async () => {
    const sent = await bot.api.answerWebAppQuery(
      webAppQueryId,
      result as unknown as Parameters<typeof bot.api.answerWebAppQuery>[1]
    );
    return sent.inline_message_id;
  }, logger);
};

// ---------------------------------------------------------------------------
// Suggested posts (channel moderation)
// ---------------------------------------------------------------------------

export const approveSuggestedPost = async (
  bot: Bot,
  chatId: number,
  messageId: number,
  scheduledDate?: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.approveSuggestedPost(chatId, messageId, {
        send_date: scheduledDate,
      }),
    logger
  );
};

export const declineSuggestedPost = async (
  bot: Bot,
  chatId: number,
  messageId: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.declineSuggestedPost(chatId, messageId),
    logger
  );
};

// ---------------------------------------------------------------------------
// Sticker Management
// ---------------------------------------------------------------------------

const mapSticker = (s: {
  custom_emoji_id?: string;
  emoji?: string;
  file_id: string;
  file_unique_id: string;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  set_name?: string;
  type: "regular" | "mask" | "custom_emoji";
  width: number;
}): StickerInfo => ({
  fileId: s.file_id,
  fileUniqueId: s.file_unique_id,
  type: s.type,
  width: s.width,
  height: s.height,
  isAnimated: s.is_animated,
  isVideo: s.is_video,
  emoji: s.emoji,
  setName: s.set_name,
  customEmojiId: s.custom_emoji_id,
});

const toInputSticker = (
  p: InputStickerParams
): Parameters<Bot["api"]["addStickerToSet"]>[2] => {
  const file =
    typeof p.sticker === "string" ? p.sticker : new InputFile(p.sticker);
  return {
    sticker: file,
    format: p.format,
    emoji_list: p.emojiList,
    keywords: p.keywords,
    mask_position: p.maskPosition
      ? {
          point: p.maskPosition.point,
          x_shift: p.maskPosition.xShift,
          y_shift: p.maskPosition.yShift,
          scale: p.maskPosition.scale,
        }
      : undefined,
  };
};

export const getStickerSet = async (
  bot: Bot,
  name: string,
  logger: TelegramLogger = createLogger()
): Promise<StickerSetInfo> => {
  return withRetry(async () => {
    const set = await bot.api.getStickerSet(name);
    return {
      name: set.name,
      title: set.title,
      stickerType: set.sticker_type,
      stickers: set.stickers.map(mapSticker),
    };
  }, logger);
};

export const getCustomEmojiStickers = async (
  bot: Bot,
  customEmojiIds: string[],
  logger: TelegramLogger = createLogger()
): Promise<StickerInfo[]> => {
  return withRetry(async () => {
    const stickers = await bot.api.getCustomEmojiStickers(customEmojiIds);
    return stickers.map(mapSticker);
  }, logger);
};

export const getForumTopicIconStickers = async (
  bot: Bot,
  logger: TelegramLogger = createLogger()
): Promise<StickerInfo[]> => {
  return withRetry(async () => {
    const stickers = await bot.api.getForumTopicIconStickers();
    return stickers.map(mapSticker);
  }, logger);
};

export const uploadStickerFile = async (
  bot: Bot,
  userId: number,
  stickerFormat: StickerFormat,
  sticker: Buffer,
  logger: TelegramLogger = createLogger()
): Promise<string> => {
  return withRetry(async () => {
    const file = await bot.api.uploadStickerFile(
      userId,
      stickerFormat,
      new InputFile(sticker)
    );
    return file.file_id;
  }, logger);
};

export const createNewStickerSet = async (
  bot: Bot,
  userId: number,
  name: string,
  title: string,
  stickers: InputStickerParams[],
  stickerType?: "custom_emoji" | "mask" | "regular",
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.createNewStickerSet(
        userId,
        name,
        title,
        stickers.map(toInputSticker),
        { sticker_type: stickerType }
      ),
    logger
  );
};

export const addStickerToSet = async (
  bot: Bot,
  userId: number,
  name: string,
  sticker: InputStickerParams,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.addStickerToSet(userId, name, toInputSticker(sticker)),
    logger
  );
};

export const setStickerPositionInSet = async (
  bot: Bot,
  sticker: string,
  position: number,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.setStickerPositionInSet(sticker, position),
    logger
  );
};

export const deleteStickerFromSet = async (
  bot: Bot,
  sticker: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.deleteStickerFromSet(sticker), logger);
};

export const replaceStickerInSet = async (
  bot: Bot,
  userId: number,
  name: string,
  oldSticker: string,
  sticker: InputStickerParams,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.replaceStickerInSet(
        userId,
        name,
        oldSticker,
        toInputSticker(sticker)
      ),
    logger
  );
};

export const setStickerEmojiList = async (
  bot: Bot,
  sticker: string,
  emojiList: string[],
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.setStickerEmojiList(sticker, emojiList),
    logger
  );
};

export const setStickerKeywords = async (
  bot: Bot,
  sticker: string,
  keywords: string[],
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.setStickerKeywords(sticker, keywords), logger);
};

export const setStickerMaskPosition = async (
  bot: Bot,
  sticker: string,
  maskPosition?: MaskPositionParams,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setStickerMaskPosition(
        sticker,
        maskPosition
          ? {
              point: maskPosition.point,
              x_shift: maskPosition.xShift,
              y_shift: maskPosition.yShift,
              scale: maskPosition.scale,
            }
          : undefined
      ),
    logger
  );
};

export const setStickerSetTitle = async (
  bot: Bot,
  name: string,
  title: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.setStickerSetTitle(name, title), logger);
};

export const deleteStickerSet = async (
  bot: Bot,
  name: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(() => bot.api.deleteStickerSet(name), logger);
};

export const setStickerSetThumbnail = async (
  bot: Bot,
  name: string,
  userId: number,
  format: StickerFormat,
  thumbnail?: Buffer | string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  let thumb: InputFile | string | undefined;
  if (thumbnail) {
    thumb =
      typeof thumbnail === "string" ? thumbnail : new InputFile(thumbnail);
  }
  await withRetry(
    () => bot.api.setStickerSetThumbnail(name, userId, thumb, format),
    logger
  );
};

export const setCustomEmojiStickerSetThumbnail = async (
  bot: Bot,
  name: string,
  customEmojiId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  await withRetry(
    () => bot.api.setCustomEmojiStickerSetThumbnail(name, customEmojiId),
    logger
  );
};

export const setChatStickerSet = async (
  bot: Bot,
  spaceId: string,
  stickerSetName: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(
    () => bot.api.setChatStickerSet(chatId, stickerSetName),
    logger
  );
};

export const deleteChatStickerSet = async (
  bot: Bot,
  spaceId: string,
  logger: TelegramLogger = createLogger()
): Promise<void> => {
  const chatId = Number(spaceId);
  await withRetry(() => bot.api.deleteChatStickerSet(chatId), logger);
};
