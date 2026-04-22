import { Bot } from "grammy";
import { definePlatform } from "../../platform/define";
import { type ManagedStream, stream } from "../../utils/stream";
import { createLogger, type TelegramLogger } from "./errors";
import {
  editMessage,
  reactToMessage,
  replyToMessage,
  send,
  startTyping,
  toMessage,
} from "./messages";
import {
  configSchema,
  type ParseMode,
  spaceParamsSchema,
  spaceSchema,
  type TelegramMessage,
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
  messages: EventSink<TelegramMessage>;
}

interface TelegramClient {
  bot: Bot;
  logger: TelegramLogger;
  parseMode?: ParseMode;
  sinks: TelegramEventSinks;
}

export const telegram = definePlatform("Telegram", {
  config: configSchema,

  space: {
    schema: spaceSchema,
    params: spaceParamsSchema,
    resolve: async ({ input, client }) => {
      const c = client as TelegramClient;
      const chatId = input.params?.chatId ?? input.users[0]?.id ?? "";

      const chat = await c.bot.api.getChat(chatId);
      const chatType = "type" in chat ? chat.type : ("private" as const);

      return {
        id: String(chat.id),
        type: chatType,
      };
    },
  },

  user: {
    resolve: async ({ input }) => ({
      id: input.userID,
    }),
  },

  lifecycle: {
    createClient: async ({ config }): Promise<TelegramClient> => {
      const logger = createLogger(config.logLevel);
      const bot = new Bot(config.token);
      await bot.init();
      logger.info(`Bot initialized: @${bot.botInfo.username}`);

      const sinks: TelegramEventSinks = {
        messages: createSink(),
      };

      bot.on("message", (ctx) => {
        if (ctx.message) {
          sinks.messages.push(toMessage(bot, ctx.message));
        }
      });

      bot.catch((err) => {
        logger.error("Bot error", err.error);
      });

      // bot.start() is intentionally not awaited — its promise never resolves
      // while polling is active, so awaiting it would block createClient forever.
      // Startup errors (bad token, network) surface through bot.catch() above.
      bot
        .start({
          allowed_updates: ["message"],
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
  },

  actions: {
    send: async ({ space, content, client }) => {
      const c = client as TelegramClient;
      return await send(c.bot, space.id, content, c.logger, c.parseMode);
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
      return await replyToMessage(
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
  },
});
