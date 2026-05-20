import type { SlackClient } from "@photon-ai/slack";
import z from "zod";
import type { SchemaMessage } from "../../platform/types";

const teamMetadataSchema = z.object({
  appId: z.string(),
  botUserId: z.string(),
  grantedScopes: z.array(z.string()),
  teamName: z.string(),
});

const directConfig = z.object({
  endpoint: z.string().optional(),
  teams: z.record(z.string(), teamMetadataSchema).optional(),
  tokens: z.record(z.string(), z.string()),
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
  channel: z.string().optional(),
  teamId: z.string(),
  threadTs: z.string().optional(),
});

/**
 * Slack-specific per-message metadata surfaced on `SlackMessage`.
 * - `ts`: the canonical Slack message timestamp id (mirrors `id` for messages
 *   sourced from the events stream; useful when constructing replies that
 *   target the same thread).
 * - `threadTs`: the parent message ts when the row is itself a threaded reply.
 * - `subtype`: Slack's subtype, e.g. `bot_message`, `message_changed`, etc.
 */
export const messageSchema = z.object({
  subtype: z.string().optional(),
  threadTs: z.string().optional(),
  ts: z.string().optional(),
});

export type SlackMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
> & {
  subtype?: string;
  threadTs?: string;
  ts?: string;
};
