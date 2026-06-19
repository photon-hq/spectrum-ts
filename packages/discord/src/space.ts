import { createDmChannel } from "./client";
import type { DiscordConfig } from "./config";

/** A Discord space is a channel (guild text channel, thread, or DM). */
export interface DiscordSpace {
  id: string;
}

export const resolveUser = ({
  input,
}: {
  input: { userID: string };
}): Promise<{ id: string }> => Promise.resolve({ id: input.userID });

/**
 * Create a space for a set of Discord users.
 *
 * A Discord "space" is a channel id, which is distinct from a user id — so a
 * single recipient resolves to their DM channel via `POST /users/@me/channels`
 * (Discord returns the existing channel if one is already open). A bot can only
 * DM a user it shares a guild with, so this may fail with 403 even for a valid
 * id.
 *
 * Bots cannot open group DMs (that needs the `gdm.join` scope and a user
 * token), so multiple recipients are rejected. Existing channels (guild text
 * channels, threads) are addressed by id via `space.get(channelId)` — Discord
 * channel ids are snowflakes; pass them as strings.
 */
export const createSpace = async ({
  input,
  config,
}: {
  input: { users: { id: string }[] };
  config: DiscordConfig;
}): Promise<DiscordSpace> => {
  const [first, ...rest] = input.users;
  if (!first) {
    throw new Error("Discord space creation requires a recipient user.");
  }
  if (rest.length > 0) {
    throw new Error(
      "Discord bots cannot create group DMs — use space.get(channelId) for an existing channel, or create a space with a single user (their DM channel)."
    );
  }
  const id = await createDmChannel(config, first.id);
  return { id };
};
