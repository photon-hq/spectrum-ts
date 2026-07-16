import {
  decodeCatchUpEvent,
  type MessageEvent,
} from "@photon-ai/advanced-imessage";
import {
  FusorTerminalError,
  type FusorVerifyRequest,
  type HybridFusorMessages,
} from "@spectrum-ts/core";
import type z from "zod";
import { getMessageCache } from "../cache";
import type { IMessageClient, RemoteClient } from "../types";
import { type configSchema, SHARED_PHONE } from "../types";
import { isSharedMode } from "./client";
import { getContactShareTracker } from "./contact-share";
import { type ReceivedEvent, toInboundMessages } from "./inbound";

const EVENT_PATH = "/imessage/events/messageChanged";
const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
const TRANSFORM_VERSIONS = new Set(["1", "2"]);
const SOURCE = "spectrum-imessage";
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

const header = (request: FusorVerifyRequest, name: string): string =>
  request.headers[name] ?? "";

const requireHeader = (request: FusorVerifyRequest, name: string): string => {
  const value = header(request, name);
  if (!value) {
    throw new Error(`Invalid iMessage Fusor event: missing ${name}`);
  }
  return value;
};

const assertVirtualGuid = (
  value: string | undefined,
  prefix: "spc-att-" | "spc-msg-",
  field: string
): void => {
  if (
    value !== undefined &&
    (!value.startsWith(prefix) || value.length === prefix.length)
  ) {
    throw new Error(
      `Invalid iMessage Fusor event: ${field} is not a virtual resource`
    );
  }
};

const assertVirtualAttachment = (
  attachment: ReceivedEvent["message"]["content"]["attachments"][number],
  field: string
): void => {
  assertVirtualGuid(attachment.guid, "spc-att-", `${field}.guid`);
  assertVirtualGuid(
    attachment.originalGuid,
    "spc-att-",
    `${field}.originalGuid`
  );
};

export const assertVirtualImessageResources = (event: ReceivedEvent): void => {
  const message = event.message;
  assertVirtualGuid(message.guid, "spc-msg-", "message.guid");
  assertVirtualGuid(
    message.threadOriginatorGuid,
    "spc-msg-",
    "message.threadOriginatorGuid"
  );
  assertVirtualGuid(
    message.replyTargetGuid,
    "spc-msg-",
    "message.replyTargetGuid"
  );
  assertVirtualGuid(
    message.reactionTargetGuid,
    "spc-msg-",
    "message.reactionTargetGuid"
  );
  for (const [index, attachment] of message.content.attachments.entries()) {
    assertVirtualAttachment(
      attachment,
      `message.content.attachments[${index}]`
    );
  }
  for (const [index, reaction] of message.appliedReactions.entries()) {
    assertVirtualGuid(
      reaction.messageGuid,
      "spc-msg-",
      `message.appliedReactions[${index}].messageGuid`
    );
  }
  for (const [index, placed] of message.placedStickers.entries()) {
    assertVirtualGuid(
      placed.messageGuid,
      "spc-msg-",
      `message.placedStickers[${index}].messageGuid`
    );
    if (placed.sticker) {
      assertVirtualAttachment(
        placed.sticker,
        `message.placedStickers[${index}].sticker`
      );
    }
  }
};

export interface ImessageFusorPayload {
  event: ReceivedEvent;
  instanceId?: string;
  transformVersion: "1" | "2";
}

/** Verify and decode a trusted transform-v1 or transform-v2 fan-in request. */
export const verifyImessageFusorRequest = (
  request: FusorVerifyRequest
): ImessageFusorPayload => {
  if (request.method !== "POST" || request.path !== EVENT_PATH) {
    throw new Error("Invalid iMessage Fusor event route");
  }
  const contentType = header(request, "content-type")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== PROTOBUF_CONTENT_TYPE) {
    throw new Error("Invalid iMessage Fusor event content type");
  }
  if (header(request, "x-fusor-source") !== SOURCE) {
    throw new Error("Invalid iMessage Fusor event source");
  }
  if (header(request, "x-fusor-imessage-event-type") !== "messageChanged") {
    throw new Error("Invalid iMessage Fusor event type");
  }
  const transformVersion = header(
    request,
    "x-fusor-imessage-transform-version"
  );
  if (!TRANSFORM_VERSIONS.has(transformVersion)) {
    throw new Error("Unsupported iMessage Fusor transform version");
  }

  const instanceId =
    transformVersion === "2"
      ? requireHeader(request, "x-fusor-imessage-instance-id")
      : header(request, "x-fusor-imessage-instance-id") || undefined;
  const logId = requireHeader(request, "x-fusor-imessage-log-id");
  if (!POSITIVE_INTEGER_RE.test(logId)) {
    throw new Error("Invalid iMessage Fusor source log id");
  }

  const decoded = decodeCatchUpEvent(request.rawBody);
  if (decoded?.type !== "message.received") {
    throw new Error("Invalid iMessage Fusor event payload");
  }
  const event = decoded as Extract<MessageEvent, { type: "message.received" }>;
  if (event.isFromMe || event.message.isFromMe) {
    throw new Error("Invalid iMessage Fusor event: outbound message");
  }
  if (String(event.sequence) !== logId) {
    throw new Error("Invalid iMessage Fusor event: sequence mismatch");
  }
  assertVirtualImessageResources(event);

  return {
    event,
    instanceId,
    transformVersion: transformVersion as "1" | "2",
  };
};

const destinationPhone = (destinationCallerId: string | undefined): string => {
  if (!destinationCallerId) {
    return "";
  }
  return destinationCallerId.startsWith("p:")
    ? destinationCallerId.slice(2)
    : destinationCallerId;
};

const selectClient = (
  clients: IMessageClient,
  payload: ImessageFusorPayload
): RemoteClient => {
  if (isSharedMode(clients)) {
    const shared = clients[0];
    if (!shared) {
      throw new FusorTerminalError("No shared iMessage client configured");
    }
    return shared;
  }

  if (payload.instanceId) {
    const selected = clients.find(
      (entry) => entry.instanceId === payload.instanceId
    );
    if (!selected) {
      throw new FusorTerminalError(
        `No iMessage client serves Fusor instance ${payload.instanceId}`
      );
    }
    const phone = destinationPhone(payload.event.message.destinationCallerId);
    if (phone && phone !== selected.phone) {
      throw new FusorTerminalError(
        `Fusor instance ${payload.instanceId} does not serve destination ${phone}`
      );
    }
    return selected;
  }

  // Retained transform-v1 frames predate the trusted instance header. Prefer
  // their destination caller id whenever present: a frame for a removed line
  // must not be silently reassigned to the sole line configured today.
  const phone = destinationPhone(payload.event.message.destinationCallerId);
  if (phone) {
    const matches = clients.filter((entry) => entry.phone === phone);
    if (matches.length === 1) {
      return matches[0] as RemoteClient;
    }
  } else if (clients.length === 1) {
    // The only safe fallback is a truly destination-less legacy frame with one
    // possible recipient.
    return clients[0] as RemoteClient;
  }

  throw new FusorTerminalError(
    "Cannot route transform-v1 iMessage Fusor event to one dedicated client"
  );
};

export const handleImessageFusorMessages: HybridFusorMessages<
  ImessageFusorPayload,
  IMessageClient,
  z.infer<typeof configSchema>
> = async ({ client, payload, projectConfig }) => {
  const selected = selectClient(client, payload);
  const phone = selected.phone === SHARED_PHONE ? SHARED_PHONE : selected.phone;
  if (projectConfig?.profile?.imessageSynced === true) {
    getContactShareTracker(selected.client).maybeShare(payload.event.chatGuid);
  }
  return await toInboundMessages(
    selected.client,
    getMessageCache(selected.client),
    payload.event,
    phone
  );
};
