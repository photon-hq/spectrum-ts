import type { ThreadAutoArchiveDuration } from "@photon-ai/discord-ts";
import type { Message } from "@spectrum-ts/core";
import {
  discordClient,
  startChannelThread,
  startThreadFromMessage,
} from "../client";
import type { DiscordConfig } from "../config";
import { parseMessageId } from "./message";

// Discord channel types for the threads it lets a bot open in a text channel.
const PUBLIC_THREAD_TYPE = 11;
const PRIVATE_THREAD_TYPE = 12;

/** Options shared by both thread-start paths. */
export interface StartThreadOptions {
  /**
   * Minutes of inactivity before Discord auto-archives the thread (one of
   * Discord's fixed durations). Defaults to the channel's setting when omitted.
   */
  autoArchiveDuration?: ThreadAutoArchiveDuration;
  /** Per-user slow-mode in seconds. */
  rateLimitPerUser?: number;
}

/** Options for a standalone thread (no starter message). */
export interface CreateThreadOptions extends StartThreadOptions {
  /** Whether non-moderators may add others to a private thread. */
  invitable?: boolean;
  /** Open a private thread (Discord type 12) instead of a public one (type 11). */
  private?: boolean;
}

/**
 * Start a thread off an existing message and return the new thread's id. The
 * thread hangs under `message` in its parent channel — `channel_id` and
 * `message_id` are taken from the message (its id resolved through
 * `parseMessageId`, which unwraps flattened group-item ids). The returned id is
 * a snowflake; address it as a space (`discord(spectrum).space.get(id)`) to post
 * into the thread.
 */
export const startThread = async ({
  config,
  message,
  name,
  options,
}: {
  config: DiscordConfig;
  message: Message;
  name: string;
  options?: StartThreadOptions;
}): Promise<string> => {
  const thread = await startThreadFromMessage(
    discordClient(config),
    message.space.id,
    parseMessageId(message.id),
    {
      name,
      auto_archive_duration: options?.autoArchiveDuration,
      rate_limit_per_user: options?.rateLimitPerUser,
    }
  );
  return thread.id;
};

/**
 * Open a standalone thread in a channel and return the new thread's id. Covers
 * text-channel threads with no starter message (public by default, private via
 * `options.private`); forum channels require a starter message and are not
 * supported here. The returned id is a snowflake addressable as a space.
 */
export const createThread = async ({
  config,
  channelId,
  name,
  options,
}: {
  config: DiscordConfig;
  channelId: string;
  name: string;
  options?: CreateThreadOptions;
}): Promise<string> => {
  const thread = await startChannelThread(discordClient(config), channelId, {
    name,
    type: options?.private ? PRIVATE_THREAD_TYPE : PUBLIC_THREAD_TYPE,
    auto_archive_duration: options?.autoArchiveDuration,
    invitable: options?.invitable,
    rate_limit_per_user: options?.rateLimitPerUser,
  });
  return thread.id;
};
