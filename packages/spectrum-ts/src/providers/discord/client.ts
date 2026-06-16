import {
  addMyMessageReaction,
  type Client,
  type CreatedThreadResponse,
  type CreateTextThreadWithMessageRequest,
  type CreateTextThreadWithoutMessageRequest,
  createDiscordClient,
  createDm,
  createMessage,
  createPin,
  createThread,
  createThreadFromMessage,
  deletePin,
  getMessage,
  type MessageResponse,
  triggerTypingIndicator,
  updateMessage,
} from "@photon-ai/discord-ts";
import type { DiscordConfig } from "./config";
import type { DiscordSendSpec } from "./types";
import { toFormData } from "./util";

/**
 * A photon Discord client (hey-api `Client`). Created per request — the
 * constructor makes no network call, so there is nothing to cache. It sends
 * `Authorization: Bot <token>`, retries 429s, and throws `DiscordApiError`
 * (token-free) on other failures.
 */
export type DiscordClient = Client;

/** Build a photon client bound to the bot token. Cheap: no network on construction. */
export const discordClient = (config: DiscordConfig): DiscordClient =>
  createDiscordClient({ token: config.botToken, baseUrl: config.baseUrl });

/**
 * Send one message to a channel. JSON-only specs go through the typed
 * `createMessage`; specs with files go through the low-level `client.post` as
 * `multipart/form-data`. Returns the created message so the caller can record
 * its id and timestamp.
 */
export const createChannelMessage = async (
  client: DiscordClient,
  channelId: string,
  spec: DiscordSendSpec
): Promise<MessageResponse> => {
  if (spec.files && spec.files.length > 0) {
    // The generated `createMessage` is JSON-only — its body type can't carry
    // file bytes and it forces `Content-Type: application/json` — so raw uploads
    // go through the low-level `client.post`. `Content-Type: null` drops that
    // default header so fetch sets the multipart boundary. The response isn't
    // schema-bound on this ad-hoc call, so its type is asserted (the typed ops
    // get this from their generated `responseValidator`).
    const res = await client.post({
      url: "/channels/{channel_id}/messages",
      path: { channel_id: channelId },
      body: spec,
      bodySerializer: () => toFormData(spec),
      headers: { "Content-Type": null },
      // The client only injects `Authorization: Bot <token>` for requests that
      // declare a security scheme; the generated ops do, but this ad-hoc call
      // must opt in explicitly or the upload goes out unauthenticated (401).
      security: [{ name: "Authorization", type: "apiKey" }],
      throwOnError: true,
    });
    return res.data as MessageResponse;
  }
  return await createMessage({
    client,
    path: { channel_id: channelId },
    body: spec.payload,
  });
};

/** Edit a previously sent message; returns the updated message. */
export const editChannelMessage = async (
  client: DiscordClient,
  channelId: string,
  messageId: string,
  body: { content: string }
): Promise<MessageResponse> =>
  await updateMessage({
    client,
    path: { channel_id: channelId, message_id: messageId },
    body,
  });

/**
 * Fetch a single message; returns the full message object. Used by the inbound
 * poll-vote path to reconstruct a poll's structure (poll-vote dispatches carry
 * only the chosen `answer_id`, not the poll itself).
 */
export const getChannelMessage = async (
  client: DiscordClient,
  channelId: string,
  messageId: string
): Promise<MessageResponse> =>
  await getMessage({
    client,
    path: { channel_id: channelId, message_id: messageId },
  });

/**
 * React to a message as the bot. `emoji` is a raw unicode emoji or a custom
 * emoji in `name:id` form; the client URL-encodes it as a path param.
 */
export const addReaction = async (
  client: DiscordClient,
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> => {
  await addMyMessageReaction({
    client,
    path: { channel_id: channelId, message_id: messageId, emoji_name: emoji },
  });
};

/**
 * Show the bot's typing indicator in a channel. Discord auto-clears it after
 * ~10s (or when the bot next sends), and there is no "stop typing" call.
 */
export const triggerTyping = async (
  client: DiscordClient,
  channelId: string
): Promise<void> => {
  await triggerTypingIndicator({ client, path: { channel_id: channelId } });
};

/**
 * Start a thread off an existing message
 * (`POST /channels/{channel_id}/messages/{message_id}/threads`). The thread
 * hangs under that message in its parent channel; Discord returns the created
 * thread, whose `id` is a snowflake addressable as a space.
 */
export const startThreadFromMessage = async (
  client: DiscordClient,
  channelId: string,
  messageId: string,
  body: CreateTextThreadWithMessageRequest
): Promise<CreatedThreadResponse> =>
  await createThreadFromMessage({
    client,
    path: { channel_id: channelId, message_id: messageId },
    body,
  });

/**
 * Open a standalone thread in a channel (`POST /channels/{channel_id}/threads`).
 * Used for text-channel threads with no starter message (public or private,
 * per `body.type`); forum channels need a starter message and are not covered
 * here. Returns the created thread, whose `id` is a snowflake addressable as a
 * space.
 */
export const startChannelThread = async (
  client: DiscordClient,
  channelId: string,
  body: CreateTextThreadWithoutMessageRequest
): Promise<CreatedThreadResponse> =>
  await createThread({
    client,
    path: { channel_id: channelId },
    body,
  });

/**
 * Pin a message in its channel
 * (`PUT /channels/{channel_id}/messages/pins/{message_id}`). A channel holds at
 * most 50 pins; pinning beyond that fails with a 400. Returns nothing.
 */
export const pinMessage = async (
  client: DiscordClient,
  channelId: string,
  messageId: string
): Promise<void> => {
  await createPin({
    client,
    path: { channel_id: channelId, message_id: messageId },
  });
};

/**
 * Unpin a previously pinned message
 * (`DELETE /channels/{channel_id}/messages/pins/{message_id}`). Idempotent from
 * the caller's view — Discord 404s if the message was never pinned. Returns
 * nothing.
 */
export const unpinMessage = async (
  client: DiscordClient,
  channelId: string,
  messageId: string
): Promise<void> => {
  await deletePin({
    client,
    path: { channel_id: channelId, message_id: messageId },
  });
};

/**
 * Open (or fetch the existing) DM channel with a user. A bot cannot DM a user it
 * shares no guild with, so this can fail with 403 even for a valid id.
 */
export const createDmChannel = async (
  config: DiscordConfig,
  recipientId: string
): Promise<string> => {
  const channel = await createDm({
    client: discordClient(config),
    body: { recipient_id: recipientId },
  });
  return (channel as { id: string }).id;
};
