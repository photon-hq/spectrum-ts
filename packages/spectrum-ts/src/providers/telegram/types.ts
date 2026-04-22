import z from "zod";
import type { SchemaMessage } from "../../platform/types";

export const parseModeSchema = z
  .enum(["MarkdownV2", "HTML", "Markdown"])
  .optional();

export type ParseMode = z.infer<typeof parseModeSchema>;

export const configSchema = z.object({
  token: z.string().min(1),
  paymentProviderToken: z.string().optional(),
  parseMode: parseModeSchema,
  logLevel: z
    .enum(["silent", "error", "warn", "info", "debug"])
    .optional()
    .default("error"),
});

export const spaceParamsSchema = z.object({
  chatId: z.string(),
});

export const spaceSchema = z.object({
  id: z.string(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
});

export type TelegramMessage = SchemaMessage<undefined, typeof spaceSchema>;
