// The `chat-sdk` Spectrum provider. Turns each Vercel `chat` SDK adapter
// (chat-sdk.dev) — Slack, Discord, Linear, Teams, and any future adapter — into
// its OWN narrowable Spectrum platform. You build the adapter (with its
// credentials); `chatSDK(adapter)` makes it a platform whose NAME is inferred
// from the adapter's own `name` ("discord" / "linear" / …), so it narrows
// exactly like the native `imessage` / `telegram` providers:
//
//   import { Spectrum } from "spectrum-ts";
//   import { chatSDK } from "spectrum-ts/providers/chat-sdk";
//   import { createDiscordAdapter } from "@chat-adapter/discord";
//   import { createLinearAdapter } from "@chat-adapter/linear";
//
//   const discord = chatSDK(createDiscordAdapter());  // platform "discord"
//   const linear = chatSDK(createLinearAdapter());    // platform "linear"
//
//   const app = await Spectrum({
//     providers: [discord.config(), linear.config({ userName: "mybot" })],
//   });
//
//   // Agnostic loop — merged across both, never branches on platform:
//   for await (const [space, message] of app.messages) {
//     if (message.content.type === "text") await space.send(`Echo: ${message.content.text}`);
//   }
//
//   // …or narrow when you want platform-specific behavior:
//   if (discord.is(message)) { /* message typed as the discord variant */ }
//   for await (const [s, m] of linear(app).messages) { /* pre-narrowed */ }
//
// Delivery: gateway adapters (Discord) are auto-pumped — no HTTP server. Webhook
// adapters (Linear) you serve yourself by mounting the platform's `webhook`
// action on your own route: `{ POST: linear(app).webhook }`. Reach the live
// adapter for native escape-hatch calls via `discord(app).chatAdapter`.

import {
  definePlatform,
  type ManagedStream,
  type Message,
  type Space,
  stream,
} from "@spectrum-ts/core";
import type { WebhookOptions } from "chat";
import { LRUCache } from "lru-cache";
import z from "zod";
import { startGatewayPump } from "./gateway";
import { SpectrumChatHost } from "./host";
import {
  type ChatHostEventPayload,
  HOST_EVENT_TYPES,
} from "./inbound/host-event";

export type { ChatHostEventPayload } from "./inbound/host-event";

import { sendContent } from "./outbound";
import { type EventQueue, makeEventQueue } from "./queue";
import { createThreadFactory, type MakeThread } from "./thread";
import type {
  ChatAdapter,
  ChatInboundMessage,
  ChatLinkPreview,
  ChatThread,
} from "./types";

const THREAD_CACHE_MAX = 1000;

// Fallback bot username when neither an explicit `userName` nor a Spectrum Cloud
// project slug is available (e.g. a local/direct run with no `projectId`).
const DEFAULT_USER_NAME = "spectrum";

// Per-instance host config. The adapter is NOT here — it's captured by
// `chatSDK(adapter)` and closed over by `createClient`; this carries only the
// optional host settings, so `discord.config()` is valid argless.
const configSchema = z.object({
  userName: z.string().optional(),
  // The chat-SDK state adapter (defaults to an in-memory store). `z.custom`
  // passes it through by reference so its methods survive config parsing.
  state: z.custom<unknown>().optional(),
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

const spaceSchema = z.object({
  id: z.string(),
  adapter: z.string().optional(),
  channelId: z.string().optional(),
  // The live chat-SDK thread for inbound-derived spaces; read it ergonomically
  // via `chatThread(space)`. Absent on spaces built from an id alone.
  thread: z.custom<ChatThread>().optional(),
});

interface ChatSdkClient {
  adapter: ChatAdapter;
  gatewayAbort: AbortController;
  gatewayPump: Promise<void>;
  makeThread: MakeThread;
  queue: EventQueue<ChatInboundMessage>;
  state: unknown;
  threads: LRUCache<string, ChatThread>;
}

// Default `state` adapter: an in-memory store, lazily imported so it stays out
// of the static import graph (same as `chat`). A stand-in — a Spectrum-managed
// state backend may replace this default later.
const resolveDefaultState = async (): Promise<unknown> => {
  try {
    const { createMemoryState } = await import("@chat-adapter/state-memory");
    return createMemoryState();
  } catch (error) {
    throw new Error(
      "chatSDK: no `state` was provided and the default in-memory state " +
        "adapter (@chat-adapter/state-memory) is not installed — install it " +
        "or pass an explicit `state`.",
      { cause: error }
    );
  }
};

// The state-adapter lifecycle the host drives. chat-SDK state adapters must be
// `connect()`-ed before use (`MemoryStateAdapter` throws otherwise) — upstream
// `Chat` does this at startup, so the provider (now the host) must too. Both
// methods are feature-detected so a minimal custom `state` need not implement
// them.
interface ConnectableState {
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
}

const connectState = (state: unknown): Promise<void> | undefined =>
  (state as ConnectableState | undefined)?.connect?.();

const disconnectState = (state: unknown): Promise<void> | undefined =>
  (state as ConnectableState | undefined)?.disconnect?.();

// Build one Spectrum platform for a single chat-SDK adapter. Everything except
// the platform `name` is fixed across adapters; `name` is inferred from the
// adapter and threaded through `definePlatform`, so the result narrows on that
// literal. The adapter is captured here and used inside `createClient`.
function builder<TName extends string>(name: TName, adapter: ChatAdapter) {
  return definePlatform(name, {
    config: configSchema,
    message: { schema: messageSchema },

    lifecycle: {
      createClient: async ({
        config,
        projectConfig,
      }): Promise<ChatSdkClient> => {
        const { ConsoleLogger, ThreadImpl } = await import("chat");
        const state = config.state ?? (await resolveDefaultState());
        // Connect before the adapter initializes — adapters (e.g. Linear OAuth)
        // and the host's dedupe both read/write state immediately.
        await connectState(state);
        const userName =
          config.userName ?? projectConfig?.slug ?? DEFAULT_USER_NAME;
        const queue = makeEventQueue<ChatInboundMessage>();
        const threads = new LRUCache<string, ChatThread>({
          max: THREAD_CACHE_MAX,
        });
        const makeThread = createThreadFactory(ThreadImpl, adapter, state);
        const host = new SpectrumChatHost({
          adapter,
          userName,
          state,
          logger: new ConsoleLogger(),
          queue,
          threads,
          makeThread,
        });
        // The adapter stores `host` as its `this.chat` and dispatches inbound
        // events back into it (headless — no Spectrum-side handler registration).
        await adapter.initialize(host);
        const gatewayAbort = new AbortController();
        const gatewayPump = startGatewayPump(adapter, gatewayAbort.signal);
        return {
          adapter,
          state,
          queue,
          threads,
          makeThread,
          gatewayAbort,
          gatewayPump,
        };
      },

      destroyClient: async ({ client }) => {
        client.gatewayAbort.abort();
        client.queue.close();
        await client.adapter.disconnect?.();
        await disconnectState(client.state);
        await client.gatewayPump.catch(() => undefined);
      },
    },

    user: {
      resolve: ({ input }) => Promise.resolve({ id: input.userID }),
    },

    space: {
      schema: spaceSchema,
      // Open a DM thread; its id is the space id.
      create: async ({ client, input }) => {
        const first = input.users[0];
        if (!first) {
          throw new Error("chatSDK space.create requires at least one user");
        }
        if (!client.adapter.openDM) {
          throw new Error(
            `chatSDK: adapter "${client.adapter.name}" cannot open DMs`
          );
        }
        const id = await client.adapter.openDM(first.id);
        return { id };
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
      sendContent(
        {
          label: client.adapter.name,
          threads: client.threads,
          makeThread: client.makeThread,
        },
        { id: space.id },
        content
      ),

    actions: {
      // Serve this adapter's inbound webhook (Linear, Discord interactions):
      // `Bun.serve({ routes: { "/webhooks/linear": { POST: linear(app).webhook } } })`.
      // `options` is `unknown` (not `WebhookOptions`) so this stays assignable to
      // a Bun route handler — `{ POST: discord(app).webhook }` — where Bun passes
      // a `Server` as the second arg. chat's `handleWebhook` ignores anything
      // without `waitUntil`, so the cast is safe for both call styles.
      webhook: (
        ctx: { client: ChatSdkClient },
        request: Request,
        options?: unknown
      ) =>
        ctx.client.adapter.handleWebhook(
          request,
          options as WebhookOptions | undefined
        ),
      // The live adapter, for native escape-hatch calls (the per-platform
      // analogue of the old single `getBot`).
      chatAdapter: (ctx: { client: ChatSdkClient }) =>
        Promise.resolve(ctx.client.adapter),
    },
  });
}

/**
 * Make a chat-SDK adapter a narrowable Spectrum platform. The platform name is
 * inferred from the adapter's own `name` literal:
 *
 *   const discord = chatSDK(createDiscordAdapter());  // platform "discord"
 *   providers: [discord.config()]
 *   discord.is(message); discord(app).messages; await linear(app).webhook(req);
 *
 * Use the `(name, adapter)` overload when an adapter's `name` is typed as the
 * widened `string` (so the literal can't be inferred) or to register two
 * adapters of the same kind under distinct platform names.
 */
export function chatSDK<TName extends string>(
  adapter: ChatAdapter & { readonly name: TName }
): ReturnType<typeof builder<TName>>;
export function chatSDK<TName extends string>(
  name: TName,
  adapter: ChatAdapter
): ReturnType<typeof builder<TName>>;
export function chatSDK(
  a: ChatAdapter | string,
  b?: ChatAdapter
): ReturnType<typeof builder<string>> {
  const adapter = (typeof a === "string" ? b : a) as ChatAdapter;
  const name = typeof a === "string" ? a : adapter.name;
  return builder(name, adapter);
}

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
 * Typed access to a chat-SDK interactive/lifecycle event surfaced on the
 * `messages` stream — button clicks, slash commands, modal submit/close,
 * dynamic-select option loads, app-home opens, the Slack assistant surface, and
 * channel-membership events. Returns the discriminated payload (narrow on
 * `chatsdk_type`) when the message is one of these host events, else
 * `undefined`. The invoking user and conversation ride `message.sender` /
 * `message.space` as on any record.
 *
 *   const event = chatHostEvent(message);
 *   if (event?.chatsdk_type === "slash-command" && event.command === "/help") {
 *     await space.send("…");
 *   }
 */
export const chatHostEvent = (
  message: Message
): ChatHostEventPayload | undefined => {
  const { content } = message;
  if (content.type !== "custom") {
    return;
  }
  const raw = (content as { raw?: unknown }).raw;
  const type = (raw as { chatsdk_type?: unknown } | undefined)?.chatsdk_type;
  return typeof type === "string" &&
    HOST_EVENT_TYPES.has(type as ChatHostEventPayload["chatsdk_type"])
    ? (raw as ChatHostEventPayload)
    : undefined;
};
