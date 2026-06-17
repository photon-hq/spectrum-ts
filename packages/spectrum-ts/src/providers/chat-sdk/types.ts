import type { Content } from "../../content/types";

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

/** A normalized link preview surfaced on an inbound chat-SDK message. */
export interface ChatLinkPreview {
  description?: string;
  imageUrl?: string;
  siteName?: string;
  title?: string;
  url: string;
}

// Structural typing for Vercel's `chat` SDK (chat-sdk.dev). We deliberately do
// NOT depend on the `chat` package — the wrapper only touches a small, stable
// subset of its surface, so a structural interface keeps this provider
// dependency-free (same philosophy as the optional express/hono peers). A
// caller's real `Chat` instance structurally satisfies `ChatBot`.

/** A normalized author on an inbound chat-SDK message. */
export interface ChatAuthor {
  fullName?: string;
  isBot?: boolean | "unknown";
  isMe?: boolean;
  userId: string;
  userName?: string;
}

/** A normalized attachment on an inbound chat-SDK message. */
export interface ChatAttachment {
  data?: Buffer | Blob;
  fetchData?: () => Promise<Buffer>;
  mimeType?: string;
  name?: string;
  size?: number;
  type: "image" | "file" | "video" | "audio";
  url?: string;
}

/** A normalized inbound message (the shape handlers receive). */
export interface ChatMessage {
  attachments?: ChatAttachment[];
  author: ChatAuthor;
  id: string;
  isMention?: boolean;
  links?: ChatLinkPreview[];
  metadata?: { dateSent?: Date; edited?: boolean; editedAt?: Date };
  text: string;
  threadId: string;
}

/** Minimal adapter surface used for reactions / edits / deletes. */
export interface ChatAdapter {
  addReaction(
    threadId: string,
    messageId: string,
    emoji: string
  ): Promise<void>;
  deleteMessage?(threadId: string, messageId: string): Promise<void>;
  editMessage?(
    threadId: string,
    messageId: string,
    message: unknown
  ): Promise<unknown>;
  readonly name: string;
}

/** Anything `thread.post()` accepts that we produce. */
export type ChatPostable =
  | string
  | { markdown: string; files?: ChatFileUpload[] }
  | { raw: string; files?: ChatFileUpload[] }
  | AsyncIterable<string>;

export interface ChatFileUpload {
  data: Buffer | Blob | ArrayBuffer;
  filename: string;
  mimeType?: string;
}

/** A sent message returned from `thread.post()`. */
export interface ChatSentMessage {
  id: string;
  threadId: string;
}

/** A thread/channel handle — the unit Spectrum maps to a `space`. */
export interface ChatThread {
  readonly adapter: ChatAdapter;
  readonly channelId?: string;
  readonly id: string;
  readonly isDM?: boolean;
  post(message: ChatPostable): Promise<ChatSentMessage>;
  startTyping?(status?: string): Promise<void>;
  subscribe?(): Promise<void>;
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

/** A reaction event delivered to `onReaction`. */
export interface ChatReactionEvent {
  added: boolean;
  messageId: string;
  rawEmoji: string;
  thread: ChatThread;
  threadId: string;
  user: ChatAuthor;
}

type MessageHandler = (
  thread: ChatThread,
  message: ChatMessage
) => void | Promise<void>;

/**
 * The subset of the chat-SDK `Chat` instance the wrapper drives. A real
 * `Chat` from `new Chat({ adapters, state, userName })` satisfies this.
 */
export interface ChatBot {
  getAdapter?(slug: string): unknown;
  initialize(): Promise<void>;
  onDirectMessage(handler: MessageHandler): void;
  onNewMention(handler: MessageHandler): void;
  onReaction(handler: (event: ChatReactionEvent) => void | Promise<void>): void;
  onSubscribedMessage(handler: MessageHandler): void;
  openDM(user: string): Promise<ChatThread>;
  shutdown(): Promise<void>;
  thread(threadId: string): ChatThread;
  /** Per-adapter webhook handlers, keyed by adapter slug. */
  readonly webhooks: Record<string, (request: Request) => Promise<Response>>;
}

/**
 * Some platforms (Discord) deliver regular messages over a Gateway WebSocket,
 * not the interactions/HTTP webhook. Such adapters expose `startGatewayListener`
 * — it opens the socket, keeps it alive for `durationMs` (and dispatches
 * messages/reactions to the bot's handlers when no `webhookUrl` is given), then
 * resolves. The wrapper feature-detects this and keeps it pumping so a
 * long-running worker maintains a live gateway. Generic by capability, not by
 * platform — any adapter with this method gets pumped.
 */
export interface ChatGatewayAdapter {
  startGatewayListener(
    options: { waitUntil?: (promise: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string
  ): Promise<unknown>;
}
