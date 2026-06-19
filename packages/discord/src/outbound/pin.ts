import type { Message } from "@spectrum-ts/core";
import { discordClient, pinMessage, unpinMessage } from "../client";
import type { DiscordConfig } from "../config";
import { parseMessageId } from "./message";

/**
 * Pin an existing message in its channel. `channel_id` and `message_id` are
 * taken from the message (its id resolved through `parseMessageId`, which unwraps
 * flattened group-item ids back to the underlying snowflake). Resolves once
 * Discord acknowledges the pin; a channel allows at most 50 pins.
 */
export const pin = async ({
  config,
  message,
}: {
  config: DiscordConfig;
  message: Message;
}): Promise<void> => {
  await pinMessage(
    discordClient(config),
    message.space.id,
    parseMessageId(message.id)
  );
};

/**
 * Unpin a message previously pinned in its channel. Like `pin`, the channel and
 * message snowflakes come from the message itself.
 */
export const unpin = async ({
  config,
  message,
}: {
  config: DiscordConfig;
  message: Message;
}): Promise<void> => {
  await unpinMessage(
    discordClient(config),
    message.space.id,
    parseMessageId(message.id)
  );
};
