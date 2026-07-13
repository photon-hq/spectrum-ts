import type { SchemaMessage } from "@spectrum-ts/core";
import z from "zod";

export const configSchema = z.object({});

export const userSchema = z.object({
  address: z.string().optional(),
  country: z.string().optional(),
  service: z.enum(["iMessage", "SMS", "RCS", "unknown"]).optional(),
});

export const spaceSchema = z.object({
  id: z.string(),
  type: z.enum(["dm", "group"]),
  phone: z.string(),
});

export const spaceParamsSchema = z.object({});

export const messageSchema = z.object({
  partIndex: z.number().int().nonnegative().optional(),
  parentId: z.string().optional(),
});

export type IMessageMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
> & {
  direction?: "inbound" | "outbound";
  partIndex?: number;
  parentId?: string;
};
