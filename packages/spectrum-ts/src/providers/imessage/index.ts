import { createClient, MessageEffect } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { z } from "zod";
import type { Edit } from "../../content/edit";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";
import type { Store } from "../../utils/store";

// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export { type BackgroundInput, background } from "./content/background";
export { effect, type IMessageMessageEffect } from "./content/effect";
export type {
  ChatRead,
  GroupChangeEvent,
  MessageEdit,
  MessageUnsend,
  ReactionRemoved,
  ReadReceipt,
} from "./remote/events";

import { createCloudClients, disposeCloudAuth } from "./auth";
import {
  type Background,
  background as backgroundContent,
  isBackground,
} from "./content/background";
import {
  getMessage as localGetMessage,
  messages as localMessages,
  send as localSend,
} from "./local/api";
import {
  editMessage as remoteEditMessage,
  getMessage as remoteGetMessage,
  messages as remoteMessages,
  reactToMessage as remoteReactToMessage,
  replyToMessage as remoteReplyToMessage,
  send as remoteSend,
  setBackground as remoteSetBackground,
  startTyping as remoteStartTyping,
  stopTyping as remoteStopTyping,
} from "./remote/api";
import { clientForPhone, isSharedMode, randomPhone } from "./remote/client";
import {
  chatReadEvents,
  groupChangeEvents,
  messageEditEvents,
  messageUnsendEvents,
  reactionRemovedEvents,
  readReceiptEvents,
} from "./remote/events";
import { dmChatGuid } from "./remote/ids";
import {
  configSchema,
  type IMessageClient,
  type IMessageMessage,
  isLocal,
  messageSchema,
  type RemoteClient,
  SHARED_PHONE,
  spaceParamsSchema,
  spaceSchema,
} from "./types";

const isPollContent = (content: { type: string }): boolean =>
  content.type === "poll" || content.type === "poll_option";

// Local-mode iMessage doesn't expose any of the custom event streams.
// Returning a one-shot empty async iterable lets the producers stay
// uniform across modes while costing nothing at runtime.
const emptyAsyncIterable = <T>(): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.resolve({ done: true, value: undefined as never }),
    };
  },
});

type IMessageEventProducer<T> = (ctx: {
  client: IMessageClient;
  config: z.infer<typeof configSchema>;
  store: Store;
}) => AsyncIterable<T>;

/**
 * Wrap a remote-only event producer so the `events:` slot can declare a
 * uniform `EventProducer<...>` shape across modes. In local mode the
 * producer is bypassed and an empty async iterable is returned.
 */
const remoteOnlyEvent =
  <T>(
    producer: (clients: RemoteClient[], store: Store) => AsyncIterable<T>
  ): IMessageEventProducer<T> =>
  ({ client, store }) =>
    isLocal(client) ? emptyAsyncIterable<T>() : producer(client, store);

const imessageEvents = {
  readReceipt: remoteOnlyEvent(readReceiptEvents),
  chatRead: remoteOnlyEvent(chatReadEvents),
  messageEdit: remoteOnlyEvent(messageEditEvents),
  messageUnsend: remoteOnlyEvent(messageUnsendEvents),
  reactionRemoved: remoteOnlyEvent(reactionRemovedEvents),
  groupChange: remoteOnlyEvent(groupChangeEvents),
};

const handleEdit = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: Edit
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action("edit", "iMessage (local mode)");
  }
  if (content.content.type !== "text") {
    // Mirrors `remoteEditMessage`'s own check — surface as an
    // UnsupportedError so dispatchSend warn-and-skips uniformly.
    throw UnsupportedError.content(
      "edit",
      "iMessage",
      `only text content can be edited (got "${content.content.type}")`
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteEditMessage(remote, space.id, content.target.id, content.content);
};

const handleBackground = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: Background
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "background",
      "iMessage (local mode)",
      "chat backgrounds require remote iMessage"
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteSetBackground(remote, space.id, content);
};

export const imessage = definePlatform("iMessage", {
  config: configSchema,

  static: {
    effect: {
      message: MessageEffect,
    },
  },

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
    }): Promise<IMessageClient> => {
      if (config.local) {
        return new IMessageSDK();
      }

      if (config.clients) {
        const entries = Array.isArray(config.clients)
          ? config.clients
          : [config.clients];
        return entries.map((e) => ({
          phone: e.phone,
          client: createClient({
            address: e.address,
            tls: true,
            token: e.token,
          }),
        }));
      }

      if (!(projectId && projectSecret)) {
        throw new Error(
          "iMessage requires projectId and projectSecret. " +
            "Either pass credentials to Spectrum(), use local mode: imessage.config({ local: true }), " +
            "or provide explicit client config: imessage.config({ clients: [...] })"
        );
      }

      return await createCloudClients(projectId, projectSecret);
    },

    destroyClient: async ({ client }) => {
      if (isLocal(client)) {
        await client.close();
        return;
      }
      await disposeCloudAuth(client);
      await Promise.all(client.map((entry) => entry.client.close()));
    },
  },

  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    params: spaceParamsSchema,
    resolve: async ({ input, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action(
          "createSpace",
          "iMessage (local mode)",
          "local mode only supports replying to existing messages"
        );
      }

      if (input.users.length === 0) {
        throw new Error("iMessage space creation requires at least one user");
      }

      if (client.length === 0) {
        throw new Error("No iMessage clients configured");
      }
      // Shared mode: ignore any user-supplied phone — there is only one
      // identity, tagged at the SHARED_PHONE sentinel.
      const phone = isSharedMode(client)
        ? SHARED_PHONE
        : (input.params?.phone ?? randomPhone(client));
      const remote = clientForPhone(client, phone);
      const addresses = input.users.map((u) => u.id);

      if (input.users.length === 1) {
        return {
          id: dmChatGuid(addresses[0] ?? ""),
          type: "dm" as const,
          phone,
        };
      }

      const { chat } = await remote.chats.create(addresses);
      return { id: chat.guid as string, type: "group" as const, phone };
    },
    actions: {
      // Sugar: `space.background(input, opts?)` →
      // `space.send(background(input, opts?))`. Wired through the universal
      // send pipeline so the unsupported-content + warn-and-skip path on
      // local-mode iMessage is identical to the canonical form.
      background: backgroundContent,
    },
  },

  message: {
    schema: messageSchema,
  },

  messages: ({ client }) =>
    isLocal(client) ? localMessages(client) : remoteMessages(client),

  // The `_Events` generic on `definePlatform` defaults to `undefined`,
  // and TypeScript's holistic inference fails to widen it from this slot
  // when several adjacent generics (`_Client`, `_MessageType`,
  // `_Events`) are resolved together — even though each producer in
  // `imessageEvents` structurally satisfies `EventProducer<unknown,
  // IMessageClient, _>`. Allowing `_Events = undefined` keeps the rest
  // of the def inferring cleanly; the cast then keeps the *runtime*
  // events record intact in `fullDef` (define.ts spreads `...def`
  // verbatim) so spectrum-ts and the webhook both discover and execute
  // every producer below. The trade-off is consumer-side: typed access
  // via `imessage(spectrum).readReceipt` currently surfaces as
  // `AsyncIterable<unknown>` rather than `AsyncIterable<ReadReceipt>`.
  // Consumers needing the narrow type cast at the call site using the
  // exported event payload types (`ReadReceipt`, `ChatRead`, …). A
  // follow-up to the spectrum-ts core can smooth the `_Events`
  // inference and remove this cast.
  events: imessageEvents as unknown as undefined,

  send: async ({ space, content, client }) => {
    if (content.type === "reply") {
      if (isLocal(client)) {
        throw UnsupportedError.action("reply", "iMessage (local mode)");
      }
      if (isPollContent(content.target.content)) {
        throw UnsupportedError.action(
          "reply",
          "iMessage",
          "iMessage polls do not support replies"
        );
      }
      const remote = clientForPhone(client, space.phone);
      return await remoteReplyToMessage(
        remote,
        space.id,
        content.target.id,
        content.content
      );
    }
    if (content.type === "reaction") {
      if (isLocal(client)) {
        throw UnsupportedError.action("react", "iMessage (local mode)");
      }
      if (isPollContent(content.target.content)) {
        throw UnsupportedError.action(
          "react",
          "iMessage",
          "iMessage polls do not support reactions"
        );
      }
      const remote = clientForPhone(client, space.phone);
      // `content.target` is statically typed as the generic `Message`, but
      // execution only reaches this iMessage `send` action when the target
      // came from the iMessage stream — hence the unknown-cast widen.
      await remoteReactToMessage(
        remote,
        space.id,
        content.target as unknown as IMessageMessage,
        content.emoji
      );
      return;
    }
    if (content.type === "typing") {
      // Local mode has no typing API — silently no-op so callers can use
      // `space.startTyping()` uniformly across modes.
      if (isLocal(client)) {
        return;
      }
      const remote = clientForPhone(client, space.phone);
      if (content.state === "start") {
        await remoteStartTyping(remote, space.id);
      } else {
        await remoteStopTyping(remote, space.id);
      }
      return;
    }
    if (content.type === "edit") {
      await handleEdit(client, space, content);
      return;
    }
    // `Background` is iMessage-only and lives outside the universal `Content`
    // union — narrow via the runtime guard rather than a `content.type ===`
    // check (which would not typecheck since `"background"` isn't a member
    // of `Content["type"]`).
    if (isBackground(content)) {
      await handleBackground(client, space, content);
      return;
    }
    if (isLocal(client)) {
      return await localSend(client, space.id, content);
    }
    const remote = clientForPhone(client, space.phone);
    return await remoteSend(remote, space.id, content);
  },

  actions: {
    getMessage: async ({ space, messageId, client }) => {
      if (isLocal(client)) {
        return localGetMessage(client, messageId);
      }
      const remote = clientForPhone(client, space.phone);
      return remoteGetMessage(remote, space.id, messageId, space.phone);
    },
  },
});
