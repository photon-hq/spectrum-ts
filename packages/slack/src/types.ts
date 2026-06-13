import type { SlackClient } from "@photon-ai/slack";
import type { SchemaMessage } from "@spectrum-ts/core";
import z from "zod";

const teamMetadataSchema = z.object({
  appId: z.string(),
  botUserId: z.string(),
  grantedScopes: z.array(z.string()),
  teamName: z.string(),
});

const directConfig = z.object({
  endpoint: z.string().optional(),
  teams: z.record(z.string(), teamMetadataSchema).optional(),
  tokens: z
    .record(z.string(), z.string().min(1))
    .refine((t) => Object.keys(t).length > 0, {
      message: "at least one token entry is required",
    }),
});

const cloudConfig = z.object({}).strict();

export const configSchema = z.union([directConfig, cloudConfig]);

export type SlackConfig = z.infer<typeof configSchema>;
export type SlackClients = SlackClient;

export const isCloudConfig = (
  config: SlackConfig
): config is z.infer<typeof cloudConfig> => !("tokens" in config);

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
  teamId: z.string(),
});

export const spaceParamsSchema = z.object({
  teamId: z.string(),
});

/**
 * Slack-specific per-message metadata surfaced on `SlackMessage`.
 * - `isFromMe`: server-stamped by spectrum-slack — `true` when `sender.id` is
 *   this installation's bot user id. Use this to filter self-echo without
 *   plumbing `bot_user_id` from `client.teams()` into the consumer.
 * - `ts`: the canonical Slack message timestamp id (mirrors `id` for messages
 *   sourced from the events stream; useful when constructing replies that
 *   target the same thread).
 * - `threadTs`: the parent message ts when the row is itself a threaded reply.
 * - `subtype`: Slack's subtype, e.g. `bot_message`, `message_changed`, etc.
 */
export const messageSchema = z.object({
  isFromMe: z.boolean(),
  subtype: z.string().optional(),
  threadTs: z.string().optional(),
  ts: z.string().optional(),
});

export type SlackMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
> & {
  isFromMe: boolean;
  subtype?: string;
  threadTs?: string;
  ts?: string;
};
