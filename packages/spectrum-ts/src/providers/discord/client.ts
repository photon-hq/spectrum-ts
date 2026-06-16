import {
  addMyMessageReaction,
  type Client,
  createDiscordClient,
  createDm,
  createMessage,
  type MessageResponse,
  triggerTypingIndicator,
  updateMessage,
} from "@photon-ai/discord-ts";
import type { DiscordConfig } from "./config";
import type { DiscordSendSpec } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;

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

// Discord file uploads are `multipart/form-data`: a `payload_json` part carries
// the JSON body and each file is a `files[n]` part. photon's typed `createMessage`
// only models the JSON body, so raw-byte uploads go through the low-level
// `client.post` with this serializer (modeled on Telegram's adapter). fetch sets
// the multipart boundary itself, so the default JSON `Content-Type` is dropped
// (`null`) at the call site.
const toFormData = (spec: DiscordSendSpec): FormData => {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(spec.payload));
  spec.files?.forEach((file, index) => {
    form.append(
      `files[${index}]`,
      new File([new Uint8Array(file.bytes)], file.filename, {
        type: file.contentType,
      }),
      file.filename
    );
  });
  return form;
};

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

/**
 * Fetch attachment bytes. Discord CDN URLs are pre-signed and public, so the
 * download is an unauthenticated `fetch` — the one place the adapter reaches
 * Discord outside the photon client.
 */
export const downloadAttachment = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `Discord media download failed: ${res.status} ${res.statusText}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
};
