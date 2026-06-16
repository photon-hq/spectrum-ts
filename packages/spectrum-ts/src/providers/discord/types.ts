import type { MessageCreateRequest } from "@photon-ai/discord-ts";

// ---------------------------------------------------------------------------
// Inbound — Discord events relayed over the Fusor control plane. Fusor holds the
// Discord Gateway connection and forwards each dispatch frame to Spectrum, so
// the payload is a Gateway dispatch (`{ t, d }`): `t` is the event name and `d`
// is the event object. `@photon-ai/discord-ts` models the HTTP API (responses),
// not Gateway events, so these inbound shapes are a hand-written subset of the
// Discord Gateway schema covering only the fields the adapter reads. They are
// types-only and disappear at build time.
// ---------------------------------------------------------------------------

/** Gateway dispatch event names the adapter handles (Discord `t`). */
export const DispatchEvent = {
  MESSAGE_CREATE: "MESSAGE_CREATE",
  MESSAGE_UPDATE: "MESSAGE_UPDATE",
  MESSAGE_DELETE: "MESSAGE_DELETE",
  MESSAGE_REACTION_ADD: "MESSAGE_REACTION_ADD",
  MESSAGE_REACTION_REMOVE: "MESSAGE_REACTION_REMOVE",
} as const;

export interface DiscordUser {
  /** Set for bot accounts. */
  bot?: boolean;
  global_name?: string | null;
  id: string;
  username: string;
}

/** A message attachment as it appears on a Discord message object. */
export interface DiscordAttachment {
  content_type?: string;
  filename: string;
  id: string;
  size: number;
  url: string;
}

/** The `d` of a MESSAGE_CREATE dispatch (subset the adapter reads). */
export interface MessageCreate {
  attachments: DiscordAttachment[];
  author: DiscordUser;
  channel_id: string;
  content: string;
  guild_id?: string;
  id: string;
  /** ISO-8601 timestamp of when the message was sent. */
  timestamp: string;
}

/**
 * The `d` of a MESSAGE_UPDATE dispatch (subset the adapter reads). Discord
 * sends the full message on a user edit, but also fires partial updates (e.g.
 * when it auto-attaches a link embed) where `author`/`content` may be absent —
 * hence the looser optionality. `edited_timestamp` is set on real content
 * edits and null otherwise.
 */
export interface MessageUpdate {
  attachments: DiscordAttachment[];
  author?: DiscordUser;
  channel_id: string;
  content: string;
  edited_timestamp?: string | null;
  guild_id?: string;
  id: string;
}

/**
 * The `d` of a MESSAGE_DELETE dispatch (subset the adapter reads). Discord
 * sends only the id of the removed message — no author or content — so this is
 * mapped to an `unsend` retracting that message.
 */
export interface MessageDelete {
  channel_id: string;
  guild_id?: string;
  id: string;
}

/** A reaction's emoji: `id` is null for unicode emoji, set for custom emoji. */
export interface ReactionEmoji {
  id: string | null;
  name: string | null;
}

/** The `d` of a MESSAGE_REACTION_ADD dispatch (subset the adapter reads). */
export interface MessageReactionAdd {
  channel_id: string;
  emoji: ReactionEmoji;
  guild_id?: string;
  message_id: string;
  user_id: string;
}

/**
 * The `d` of a MESSAGE_REACTION_REMOVE dispatch. Discord sends the same fields
 * as MESSAGE_REACTION_ADD, so the adapter reads the identical subset and maps
 * the removal to an `unsend` retracting the reaction.
 */
export type MessageReactionRemove = MessageReactionAdd;

/**
 * One Gateway dispatch frame as Fusor relays it. `op` (0 for dispatch) and `s`
 * (sequence) are carried for fidelity but unused. The handler switches on `t`
 * and narrows `d` accordingly.
 */
export interface GatewayDispatch {
  d: unknown;
  op?: number;
  s?: number | null;
  t: string;
}

/**
 * The payload `verify()` produces and `messages()` consumes: the parsed Gateway
 * dispatch. Receiving is pure parsing — no client or config is bundled here. The
 * inbound mapper reads `config` from its own ctx and creates a client inline
 * only when it needs to fetch attachment bytes.
 */
export type DiscordPayload = GatewayDispatch;

// ---------------------------------------------------------------------------
// Outbound — the adapter's own DTO at the REST boundary. Discord sends every
// message kind through one endpoint (`POST /channels/{id}/messages`): text in
// `content`, files as multipart parts. So `buildSend` returns a single
// `DiscordSendSpec` and `createMessage` runs it through the REST client.
// ---------------------------------------------------------------------------

/** A file to upload as a multipart `files[n]` part. */
export interface DiscordSendFile {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

/** One `POST /channels/{id}/messages` call: the JSON body plus any files. */
export interface DiscordSendSpec {
  files?: DiscordSendFile[];
  /** The Discord message-create body (e.g. `content`, `embeds`, `message_reference`). */
  payload: MessageCreateRequest;
}
