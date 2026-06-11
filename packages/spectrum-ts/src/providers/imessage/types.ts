import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import z from "zod";
import type { SchemaMessage } from "../../platform/types";

export interface RemoteClient {
  client: AdvancedIMessage;
  phone: string;
}

export type IMessageClient = IMessageSDK | RemoteClient[];

/**
 * Sentinel phone for shared-token mode. The single shared client serves an
 * unknown set of numbers (the SDK exposes no recipient field on inbound and
 * no `from` parameter on send), so all routing through it tags this sentinel.
 */
export const SHARED_PHONE = "shared";

export const isLocal = (client: IMessageClient): client is IMessageSDK =>
  client instanceof IMessageSDK;

const clientEntry = z.object({
  address: z.string(),
  token: z.string(),
  phone: z.string(),
});

export const configSchema = z.union([
  z.object({ local: z.literal(true) }),
  z.object({
    local: z.literal(false).optional().default(false),
    clients: clientEntry.or(z.array(clientEntry)).optional(),
  }),
]);

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
  type: z.enum(["dm", "group"]),
  phone: z.string(),
});

export const spaceParamsSchema = z.object({
  phone: z.string().optional(),
});

/**
 * iMessage-specific per-message metadata surfaced on `IMessageMessage`.
 * - `partIndex`: attachment index within a multi-part message (0 for bare
 *   or single-attachment messages; 0..N-1 for a group's sub-items).
 * - `parentId`: guid of the parent message for a group sub-item. Undefined
 *   when the message itself is the parent.
 */
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
