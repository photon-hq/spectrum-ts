// Types for the `chat` SDK (chat-sdk.dev). Rather than mirror chat's surface with
// hand-written structural interfaces, we alias the REAL types from the package —
// so a signature change upstream is a compile error here, not a silent runtime
// surprise, and `SpectrumChatHost` can `implements ChatInstance` directly. The
// `Chat*` alias names are kept (instead of importing the real names bare) for two
// reasons: they avoid colliding with Spectrum's own `Message`/`Space`/`Content`
// types, and they leave the provider's ~13 internal import sites untouched.
//
// These are `import type` only — erased at compile time — so `chat` stays out of
// the static runtime import graph. The single runtime touch is the lazy
// `await import("chat")` in `createClient` (for `ConsoleLogger` + `ThreadImpl`).

import type { Content } from "@spectrum-ts/core";
import type {
  ActionEvent,
  Adapter,
  AppHomeOpenedEvent,
  AssistantThreadStartedEvent,
  Attachment,
  Author,
  FileUpload,
  LinkPreview,
  MemberJoinedChannelEvent,
  Message,
  ModalCloseEvent,
  ModalSubmitEvent,
  OptionsLoadEvent,
  ReactionEvent,
  SentMessage,
  SlashCommandEvent,
  Thread,
} from "chat";

// --- aliases onto the real chat types --------------------------------------
// The adapter the provider drives, the inbound message it parses, and the
// thread/author/attachment/link shapes — all the real thing now.
export type ChatAdapter = Adapter;
export type ChatMessage = Message;
export type ChatThread = Thread;
export type ChatAuthor = Author;
export type ChatAttachment = Attachment;
export type ChatLinkPreview = LinkPreview;
export type ChatSentMessage = SentMessage;
export type ChatFileUpload = FileUpload;

// Host-event params, aliased to EXACTLY the shapes `ChatInstance` declares (its
// methods receive these `Omit`-narrowed events), so implementing the interface
// type-checks and the converters in `inbound/` read real fields.
export type ChatReactionEvent = Omit<ReactionEvent, "adapter" | "thread"> & {
  adapter?: Adapter;
};
export type ChatActionEvent = Omit<ActionEvent, "thread" | "openModal"> & {
  adapter: Adapter;
};
export type ChatSlashCommandEvent = Omit<
  SlashCommandEvent,
  "channel" | "openModal"
> & { adapter: Adapter; channelId: string };
export type ChatModalSubmitEvent = Omit<
  ModalSubmitEvent,
  "relatedThread" | "relatedMessage" | "relatedChannel"
>;
export type ChatModalCloseEvent = Omit<
  ModalCloseEvent,
  "relatedThread" | "relatedMessage" | "relatedChannel"
>;
export type ChatOptionsLoadEvent = OptionsLoadEvent;
export type ChatAppHomeOpenedEvent = AppHomeOpenedEvent;
export type ChatMemberJoinedChannelEvent = MemberJoinedChannelEvent;
// `AssistantThreadStartedEvent` and `AssistantContextChangedEvent` are
// structurally identical; one alias covers both converters.
export type ChatAssistantEvent = AssistantThreadStartedEvent;

// --- types Spectrum genuinely owns (NOT part of chat's surface) ------------

// The exact inbound record the `messages` stream yields. Mirrors the resolved
// message type (required sender/space/timestamp + declared extras) so the
// stream is assignable to the `messages` contract — the looser
// `ProviderMessageRecord` (optional sender) is not. Same approach as terminal.
export interface ChatInboundMessage {
  content: Content;
  edited?: boolean;
  editedAt?: Date;
  id: string;
  isMention?: boolean;
  links?: ChatLinkPreview[];
  sender: { id: string };
  space: {
    id: string;
    adapter?: string;
    channelId?: string;
    thread?: ChatThread;
  };
  timestamp: Date;
}

/**
 * Maps a `space.id` (the inbound thread id) to the live `thread` handle from
 * the event that created it. Outbound prefers this over `bot.thread(id)`: a
 * stored `thread.post()` goes through `thread.adapter` directly, so it works
 * regardless of how the adapter was keyed on the bot. `Map` and `LRUCache`
 * both satisfy it.
 */
export interface ThreadRegistry {
  get(threadId: string): ChatThread | undefined;
  set(threadId: string, thread: ChatThread): unknown;
}

/**
 * Some platforms (Discord) deliver regular messages over a Gateway WebSocket,
 * not the interactions/HTTP webhook. Such adapters expose `startGatewayListener`
 * — it opens the socket, keeps it alive for `durationMs` (and dispatches
 * messages/reactions to the bot's handlers when no `webhookUrl` is given), then
 * resolves. The wrapper feature-detects this and keeps it pumping so a
 * long-running worker maintains a live gateway. This capability is NOT on chat's
 * `Adapter` interface (it's adapter-implementation-specific), so it stays a
 * local structural type — generic by capability, not by platform.
 */
export interface ChatGatewayAdapter {
  startGatewayListener(
    options: { waitUntil?: (promise: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string
  ): Promise<unknown>;
}
