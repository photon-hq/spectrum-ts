import type { ReactionType, ServiceType } from "@linqapp/sdk/resources/shared";
import type {
  EventsWebhookEvent,
  MessageEventV2,
} from "@linqapp/sdk/resources/webhooks";

// ---------------------------------------------------------------------------
// Inbound — LinQ webhook payloads, re-exported from the official SDK types so
// the adapter stays in sync with LinQ's schema.
// ---------------------------------------------------------------------------

export type {
  ChatHandle,
  ReactionType,
  ServiceType,
} from "@linqapp/sdk/resources/shared";
export type {
  EventsWebhookEvent,
  MessageEventV2,
  ReactionEventBase,
  SchemasMediaPartResponse,
  SchemasTextPartResponse,
} from "@linqapp/sdk/resources/webhooks";

/** The full webhook envelope `verify()` produces and `messages()` consumes. */
export type LinqPayload = EventsWebhookEvent;

/** One part of an inbound message (text, media, or link). */
export type LinqInboundPart = MessageEventV2["parts"][number];

// ---------------------------------------------------------------------------
// Outbound — the adapter's own DTOs at the `LinqClient` boundary. Decoupled
// from the SDK's request types so `send` code reads cleanly; `client.ts` maps
// these onto SDK calls.
// ---------------------------------------------------------------------------

export type LinqOutboundPart =
  | { type: "text"; value: string }
  | { type: "media"; attachmentId?: string; url?: string }
  | { type: "link"; value: string };

export interface LinqOutboundMessage {
  effect?: { name: string; type?: "screen" | "bubble" };
  idempotencyKey?: string;
  parts: LinqOutboundPart[];
  preferredService?: ServiceType;
  replyTo?: { messageId: string; partIndex?: number };
}

export interface LinqReactionInput {
  customEmoji?: string;
  operation: "add" | "remove";
  partIndex?: number;
  type: ReactionType;
}

export interface LinqUploadInput {
  bytes: Buffer;
  contentType: string;
  filename: string;
}
