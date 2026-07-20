import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import type { SchemaMessage } from "@spectrum-ts/core";
import z from "zod";

export interface RemoteClient {
  client: AdvancedIMessage;
  phone: string;
}

export type IMessageClient = RemoteClient[];

/**
 * Sentinel phone for shared-token mode. The single shared client serves an
 * unknown set of numbers (the SDK exposes no recipient field on inbound and
 * no `from` parameter on send), so all routing through it tags this sentinel.
 */
export const SHARED_PHONE = "shared";

const clientEntry = z.object({
  address: z.string(),
  token: z.string(),
  phone: z.string(),
});

export const configSchema = z.strictObject({
  clients: clientEntry.or(z.array(clientEntry)).optional(),
});

/**
 * iMessage sender identity. `id` is the cross-provider key (the address);
 * `address`/`country`/`service` mirror the SDK's `SingleServiceAddressInfo`,
 * letting apps tell iMessage from SMS/RCS. All optional because actor-less
 * events cannot always supply them.
 */
const SERVICE_VALUES = ["iMessage", "SMS", "RCS", "unknown"] as const;

export const userSchema = z.object({
  address: z.string().optional(),
  country: z.string().optional(),
  service: z.enum(SERVICE_VALUES).optional(),
});

export const spaceSchema = z.object({
  id: z.string(),
  type: z.enum(["dm", "group"]),
  phone: z.string(),
});

export const spaceParamsSchema = z.object({
  phone: z.string().optional(),
});

const miniAppCardSessionSchema = z.object({
  chatGuid: z.string(),
  messageGuid: z.string(),
  sessionId: z.string(),
  targetMessageGuid: z.string(),
});

/**
 * iMessage-specific per-message metadata surfaced on `IMessageMessage`.
 * - `partIndex`: ordered part index within a multi-part message. Text and
 *   attachment parts both consume an index (0 for bare or single-part
 *   messages; 0..N-1 for a group's sub-items).
 * - `parentId`: guid of the parent message for a group sub-item. Undefined
 *   when the message itself is the parent.
 * - `miniAppCardSession`: stable handle returned by mini-app card sends and
 *   updates. It is required to update the card in place later.
 */
export const messageSchema = z.object({
  miniAppCardSession: miniAppCardSessionSchema.optional(),
  partIndex: z.number().int().nonnegative().optional(),
  parentId: z.string().optional(),
});

export type IMessageMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
> & {
  direction?: "inbound" | "outbound";
  miniAppCardSession?: z.infer<typeof miniAppCardSessionSchema>;
  partIndex?: number;
  parentId?: string;
};
