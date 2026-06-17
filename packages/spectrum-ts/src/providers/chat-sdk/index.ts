// The `chat-sdk` Spectrum provider. Wraps a configured Vercel `chat` SDK bot
// (chat-sdk.dev) so its entire adapter ecosystem — Slack, Discord, Teams,
// Google Chat, and any future adapters — becomes usable through Spectrum's
// messaging API. You own all chat-SDK setup (adapters, state, credentials);
// Spectrum drives the conversation.
//
//   import { Spectrum } from "spectrum-ts";
//   import { chatSDK } from "spectrum-ts/providers/chat-sdk";
//   import { Chat } from "chat";
//   import { createSlackAdapter } from "@chat-adapter/slack";
//
//   const bot = new Chat({
//     adapters: { slack: createSlackAdapter() },
//     state,
//     userName: "mybot",
//   }); // wired but headless — DO NOT register your own message handlers
//
//   const app = await Spectrum({ providers: [chatSDK(bot)] });
//
//   // You own the HTTP server: mount each adapter's webhook handler on your
//   // own route — Bun.serve, Hono, Express, a Next.js route, etc. — exactly as
//   // the chat SDK documents. Spectrum only drives the conversation; the bot's
//   // handlers (which feed `app.messages`) fire when your route invokes them.
//   Bun.serve({
//     port: 3000,
//     routes: { "/webhooks/slack": { POST: bot.webhooks.slack } },
//   });
//
//   for await (const [space, message] of app.messages) {
//     if (message.content.type === "text") {
//       await space.send(`Echo: ${message.content.text}`);
//     }
//   }

import { LRUCache } from "lru-cache";
import z from "zod";
import { definePlatform } from "../../platform/define";
import type { SpectrumLike } from "../../platform/types";
import type { Message } from "../../types/message";
import type { Space } from "../../types/space";
import { type ManagedStream, stream } from "../../utils/stream";
import { startGatewayPump } from "./gateway";
import { registerInbound } from "./inbound/register";
import { sendContent } from "./outbound";
import { type EventQueue, makeEventQueue } from "./queue";
import type {
  ChatBot,
  ChatInboundMessage,
  ChatLinkPreview,
  ChatThread,
} from "./types";

const THREAD_CACHE_MAX = 1000;

// The live bot is an opaque runtime object, carried through `config` the same
// way an attachment carries its `read()` fn.
const configSchema = z.object({
  bot: z.custom<ChatBot>(
    (value) => typeof value === "object" && value !== null,
    { message: "chatSDK(bot): expected a chat-SDK Chat instance" }
  ),
});

// Message-level extras only; `adapter`/`channelId`/`thread` ride on the `space`.
// Declaring these keeps Spectrum's buildMessage filter from stripping them (and
// zod sanitizes each `links` entry to plain data, dropping the SDK's fns).
const messageSchema = z.object({
  isMention: z.boolean().optional(),
  edited: z.boolean().optional(),
  editedAt: z.date().optional(),
  links: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        imageUrl: z.string().optional(),
        siteName: z.string().optional(),
      })
    )
    .optional(),
});

interface ChatSdkClient {
  bot: ChatBot;
  gatewayAbort: AbortController;
  gatewayPump: Promise<void>;
  queue: EventQueue<ChatInboundMessage>;
  threads: LRUCache<string, ChatThread>;
}

export const chatSdkPlatform = definePlatform("ChatSDK", {
  config: configSchema,

  message: { schema: messageSchema },

  lifecycle: {
    createClient: async ({ config }): Promise<ChatSdkClient> => {
      const { bot } = config;
      const queue = makeEventQueue<ChatInboundMessage>();
      const threads = new LRUCache<string, ChatThread>({
        max: THREAD_CACHE_MAX,
      });
      registerInbound(bot, queue, threads);
      await bot.initialize();
      const gatewayAbort = new AbortController();
      const gatewayPump = startGatewayPump(bot, gatewayAbort.signal);
      return { bot, queue, gatewayAbort, gatewayPump, threads };
    },

    destroyClient: async ({ client }) => {
      client.gatewayAbort.abort();
      client.queue.close();
      await client.bot.shutdown();
      await client.gatewayPump.catch(() => undefined);
    },
  },

  user: {
    resolve: ({ input }) => Promise.resolve({ id: input.userID }),
  },

  space: {
    schema: z.object({
      id: z.string(),
      adapter: z.string().optional(),
      channelId: z.string().optional(),
      // The live chat-SDK thread for inbound-derived spaces; read it ergonomically
      // via `chatThread(space)`. Absent on spaces built from an id alone.
      thread: z.custom<ChatThread>().optional(),
    }),
    // Open a DM thread; its id is the space id.
    create: async ({ client, input }) => {
      const first = input.users[0];
      if (!first) {
        throw new Error("chatSDK space.create requires at least one user");
      }
      const thread = await client.bot.openDM(first.id);
      return { id: thread.id };
    },
    get: ({ input }) => Promise.resolve({ id: input.id }),
  },

  messages: ({ client }): ManagedStream<ChatInboundMessage> =>
    stream<ChatInboundMessage>((emit, end) => {
      const iterator = client.queue.iter[Symbol.asyncIterator]();
      const pump = (async () => {
        try {
          let result = await iterator.next();
          while (!result.done) {
            await emit(result.value);
            result = await iterator.next();
          }
          end();
        } catch (error) {
          end(error);
        }
      })();
      return async () => {
        await iterator.return?.();
        await pump.catch(() => undefined);
      };
    }),

  send: ({ client, space, content }) =>
    sendContent(client.bot, client.threads, { id: space.id }, content),
});

/**
 * Wrap a configured chat-SDK bot as a Spectrum provider.
 *
 * The bot must be **wired but headless** — adapters/state/credentials
 * configured, but with no message handlers registered, since Spectrum becomes
 * the handler (your logic lives in the `app.messages` loop).
 *
 * Serving webhooks is through your own server: mount each `bot.webhooks.<slug>`
 * handler on your own HTTP route (Bun.serve, Hono, Express, …), as the chat
 * SDK documents.
 */
export const chatSDK = (bot: ChatBot) => chatSdkPlatform.config({ bot });

/** Chat-SDK enrichment carried on an inbound Spectrum message. */
export interface ChatMessageMeta {
  edited: boolean;
  editedAt?: Date;
  isMention: boolean;
  links: ChatLinkPreview[];
}

/**
 * Typed access to the chat-SDK enrichment on an inbound message — mention
 * state, edited state, and link previews — without casting.
 */
export const messageMeta = (message: Message): ChatMessageMeta => {
  const m = message as Message & {
    isMention?: boolean;
    edited?: boolean;
    editedAt?: Date;
    links?: ChatLinkPreview[];
  };
  return {
    isMention: m.isMention ?? false,
    edited: m.edited ?? false,
    editedAt: m.editedAt,
    links: m.links ?? [],
  };
};

/**
 * The live chat-SDK `Thread` backing an inbound-derived space — the escape
 * hatch for native per-conversation calls (`postEphemeral`, `openModal`,
 * `subscribe`, history). `undefined` for spaces built from an id alone.
 */
export const chatThread = (space: Space): ChatThread | undefined =>
  (space as Space & { thread?: ChatThread }).thread;

/**
 * The underlying chat-SDK `Chat` instance, for modules that only have the
 * Spectrum `app` (you usually already hold your own `bot` reference). Available
 * once the provider's client has been created.
 */
export const getBot = (app: SpectrumLike): ChatBot | undefined => {
  const runtime = app.__internal.platforms.get("ChatSDK") as
    | { client?: ChatSdkClient }
    | undefined;
  return runtime?.client?.bot;
};
