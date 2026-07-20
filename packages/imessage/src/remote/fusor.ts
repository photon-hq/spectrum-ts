import {
  decodeCatchUpEvent,
  type MessageEvent,
} from "@photon-ai/advanced-imessage/http";
import {
  FusorTerminalError,
  type FusorVerifyRequest,
  type HybridFusorMessages,
} from "@spectrum-ts/core";
import type z from "zod";
import { getMessageCache } from "../cache";
import type { IMessageClient, RemoteClient } from "../types";
import { type configSchema, SHARED_PHONE } from "../types";
import { inspectCatchUpSequence } from "./catchup-sequence";
import { clientEntryForLine, isSharedMode } from "./client";
import { getContactShareTracker } from "./contact-share";
import { type ReceivedEvent, toInboundMessages } from "./inbound";

const EVENT_PATH = "/imessage/events/messageChanged";
const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
type LegacyTransformVersion = "1" | "2" | "3";

const LEGACY_TRANSFORM_VERSIONS = new Set<LegacyTransformVersion>([
  "1",
  "2",
  "3",
]);
const LEGACY_SOURCE = "spectrum-imessage";
const DEDICATED_SOURCE = "fusor-fanin-imessage";
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

interface LegacyImessageFusorPayload {
  event: ReceivedEvent;
  instanceId?: string;
  kind: "legacy";
  sourceSequence: string;
  transformVersion: LegacyTransformVersion;
}

interface DedicatedImessageFusorPayload {
  event: ReceivedEvent;
  kind: "dedicated";
  lineId: string;
  phone: string;
  sourceSequence: string;
  transformVersion: "4";
}

export type ImessageFusorPayload =
  | DedicatedImessageFusorPayload
  | LegacyImessageFusorPayload;

const destinationPhone = (
  destinationCallerId: string | undefined
): string | undefined => {
  if (destinationCallerId === undefined) {
    return;
  }
  return destinationCallerId.startsWith("p:")
    ? destinationCallerId.slice(2)
    : destinationCallerId;
};

const decodeReceivedEvent = (
  rawBody: Uint8Array,
  sourceSequence: string
): ReceivedEvent => {
  const inspection = inspectCatchUpSequence(rawBody);
  if (inspection.sequenceDecimal !== sourceSequence) {
    throw new Error("Invalid iMessage Fusor event: sequence mismatch");
  }
  const decoded = decodeCatchUpEvent(inspection.decoderBody);
  if (decoded?.type !== "message.received") {
    throw new Error("Invalid iMessage Fusor event payload");
  }
  const event = decoded as Extract<MessageEvent, { type: "message.received" }>;
  if (event.isFromMe || event.message.isFromMe) {
    throw new Error("Invalid iMessage Fusor event: outbound message");
  }
  return event;
};

const isLegacyTransformVersion = (
  value: string
): value is LegacyTransformVersion =>
  LEGACY_TRANSFORM_VERSIONS.has(value as LegacyTransformVersion);

const assertBaseRequest = (request: FusorVerifyRequest): void => {
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
  if (header(request, "x-fusor-imessage-event-type") !== "messageChanged") {
    throw new Error("Invalid iMessage Fusor event type");
  }
};

const parseLegacyPayload = (
  request: FusorVerifyRequest,
  transformVersion: LegacyTransformVersion
): LegacyImessageFusorPayload => {
  const sourceSequence = requireHeader(request, "x-fusor-imessage-log-id");
  if (!POSITIVE_INTEGER_RE.test(sourceSequence)) {
    throw new Error("Invalid iMessage Fusor source log id");
  }
  const event = decodeReceivedEvent(request.rawBody, sourceSequence);
  assertVirtualImessageResources(event);
  return {
    event,
    instanceId:
      transformVersion === "2" || transformVersion === "3"
        ? requireHeader(request, "x-fusor-imessage-instance-id")
        : header(request, "x-fusor-imessage-instance-id") || undefined,
    kind: "legacy",
    sourceSequence,
    transformVersion,
  };
};

const parseDedicatedPayload = (
  request: FusorVerifyRequest
): DedicatedImessageFusorPayload => {
  if (header(request, "x-fusor-imessage-instance-id")) {
    throw new Error(
      "Invalid dedicated iMessage Fusor event: physical instance id is forbidden"
    );
  }
  const lineId = requireHeader(request, "x-fusor-imessage-line-id");
  if (!UUID_RE.test(lineId)) {
    throw new Error("Invalid dedicated iMessage Fusor line id");
  }
  const phone = requireHeader(request, "x-fusor-imessage-phone");
  if (!E164_RE.test(phone)) {
    throw new Error("Invalid dedicated iMessage Fusor phone");
  }
  const sourceSequence = requireHeader(
    request,
    "x-fusor-imessage-source-sequence"
  );
  if (!POSITIVE_INTEGER_RE.test(sourceSequence)) {
    throw new Error("Invalid dedicated iMessage Fusor source sequence");
  }
  const event = decodeReceivedEvent(request.rawBody, sourceSequence);
  const destination = destinationPhone(event.message.destinationCallerId);
  if (destination !== undefined && destination !== phone) {
    throw new Error(
      `Invalid dedicated iMessage Fusor destination ${destination}`
    );
  }
  return {
    event,
    kind: "dedicated",
    lineId,
    phone,
    sourceSequence,
    transformVersion: "4",
  };
};

/** Verify and decode a supported, trusted iMessage fan-in request. */
export const verifyImessageFusorRequest = (
  request: FusorVerifyRequest
): ImessageFusorPayload => {
  assertBaseRequest(request);
  const source = header(request, "x-fusor-source");
  const transformVersion = header(
    request,
    "x-fusor-imessage-transform-version"
  );

  if (source === LEGACY_SOURCE && isLegacyTransformVersion(transformVersion)) {
    return parseLegacyPayload(request, transformVersion);
  }

  if (source === DEDICATED_SOURCE && transformVersion === "4") {
    return parseDedicatedPayload(request);
  }

  throw new Error("Invalid iMessage Fusor source and transform version pair");
};

const selectClient = (
  clients: IMessageClient,
  payload: ImessageFusorPayload
): RemoteClient => {
  if (payload.kind === "legacy") {
    if (!isSharedMode(clients)) {
      throw new FusorTerminalError(
        "Legacy virtual iMessage events require shared mode"
      );
    }
    const shared = clients[0];
    if (!shared) {
      throw new FusorTerminalError("No shared iMessage client configured");
    }
    return shared;
  }

  if (isSharedMode(clients)) {
    throw new FusorTerminalError(
      `Dedicated iMessage line ${payload.lineId} cannot use shared mode`
    );
  }
  const selected = clientEntryForLine(clients, payload.lineId, payload.phone);
  if (selected) {
    return selected;
  }
  throw new FusorTerminalError(
    `No iMessage client serves Fusor line ${payload.lineId} at ${payload.phone}`
  );
};

export const handleImessageFusorMessages: HybridFusorMessages<
  ImessageFusorPayload,
  IMessageClient,
  z.infer<typeof configSchema>
> = async ({ client, payload, projectConfig }) => {
  const selected = selectClient(client, payload);
  const phone = payload.kind === "dedicated" ? payload.phone : SHARED_PHONE;
  const lineId = payload.kind === "dedicated" ? payload.lineId : undefined;
  const messages = await toInboundMessages(
    selected.client,
    getMessageCache(selected.client),
    payload.event,
    phone,
    lineId
  );
  if (projectConfig?.profile?.imessageSynced === true) {
    getContactShareTracker(selected.client).maybeShare(payload.event.chatGuid);
  }
  return messages;
};
