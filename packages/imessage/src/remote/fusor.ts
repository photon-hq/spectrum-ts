import {
  decodeCatchUpEvent,
  type GroupEvent,
  type MessageEvent,
  type PollEvent,
} from "@photon-ai/advanced-imessage/http";
import {
  FusorTerminalError,
  type FusorVerifyRequest,
  type HybridFusorMessages,
} from "@spectrum-ts/core";
import type z from "zod";
import { getMessageCache, getPollCache } from "../cache";
import type { IMessageClient, RemoteClient } from "../types";
import { type configSchema, SHARED_PHONE } from "../types";
import { inspectCatchUpSequence } from "./catchup-sequence";
import { clientEntryForPhone, isSharedMode } from "./client";
import { getContactShareTracker } from "./contact-share";
import { groupEventActor, toGroupEventMessages } from "./group-events";
import { type ReceivedEvent, toInboundMessages } from "./inbound";
import { cachePollEvent, toPollDeltaMessages } from "./polls";
import { toReactionMessages } from "./reactions";

const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
type LegacyTransformVersion = "1" | "2" | "3";
type ReactionAddedEvent = Extract<
  MessageEvent,
  { type: "message.reactionAdded" }
>;
type DedicatedImessageEvent =
  | GroupEvent
  | PollEvent
  | ReactionAddedEvent
  | ReceivedEvent;

const DEDICATED_EVENT_TYPES = {
  groupChanged: "group.changed",
  messageChanged: "message.received",
  pollChanged: "poll.changed",
  reactionAdded: "message.reactionAdded",
} as const;
type DedicatedImessageEventType = keyof typeof DEDICATED_EVENT_TYPES;

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
  event: DedicatedImessageEvent;
  eventType: DedicatedImessageEventType;
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

const receivedChatGuid = (event: ReceivedEvent): string | undefined =>
  event.chatGuid || event.message.chatGuids?.[0];

const decodeEvent = (
  rawBody: Uint8Array,
  sourceSequence: string
): ReturnType<typeof decodeCatchUpEvent> => {
  const inspection = inspectCatchUpSequence(rawBody);
  if (inspection.sequenceDecimal !== sourceSequence) {
    throw new Error("Invalid iMessage Fusor event: sequence mismatch");
  }
  return decodeCatchUpEvent(inspection.decoderBody);
};

const decodeReceivedEvent = (
  rawBody: Uint8Array,
  sourceSequence: string
): ReceivedEvent => {
  const decoded = decodeEvent(rawBody, sourceSequence);
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
  if (request.method !== "POST") {
    throw new Error("Invalid iMessage Fusor event route");
  }
  const contentType = header(request, "content-type")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== PROTOBUF_CONTENT_TYPE) {
    throw new Error("Invalid iMessage Fusor event content type");
  }
};

const assertEventContract = (
  request: FusorVerifyRequest,
  eventType: string
): void => {
  if (
    request.path !== `/imessage/events/${eventType}` ||
    header(request, "x-fusor-imessage-event-type") !== eventType
  ) {
    throw new Error("Invalid iMessage Fusor event type");
  }
};

const isDedicatedEventType = (
  value: string
): value is DedicatedImessageEventType =>
  Object.hasOwn(DEDICATED_EVENT_TYPES, value);

const parseLegacyPayload = (
  request: FusorVerifyRequest,
  transformVersion: LegacyTransformVersion
): LegacyImessageFusorPayload => {
  assertEventContract(request, "messageChanged");
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
  const eventType = requireHeader(request, "x-fusor-imessage-event-type");
  if (!isDedicatedEventType(eventType)) {
    throw new Error("Invalid dedicated iMessage Fusor event type");
  }
  assertEventContract(request, eventType);
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
  const event = decodeEvent(request.rawBody, sourceSequence);
  if (event?.type !== DEDICATED_EVENT_TYPES[eventType]) {
    throw new Error("Invalid dedicated iMessage Fusor event payload");
  }
  if (event.type === "message.received") {
    if (event.isFromMe || event.message.isFromMe) {
      throw new Error("Invalid iMessage Fusor event: outbound message");
    }
    const destination = destinationPhone(event.message.destinationCallerId);
    if (destination !== undefined && destination !== phone) {
      throw new Error(
        `Invalid dedicated iMessage Fusor destination ${destination}`
      );
    }
  }
  if (event.type !== "message.received" && !event.chatGuid) {
    throw new Error(
      "Invalid dedicated iMessage Fusor event: missing chat guid"
    );
  }
  return {
    event,
    eventType,
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
  try {
    return clientEntryForPhone(clients, payload.phone);
  } catch {
    throw new FusorTerminalError(
      `No iMessage client serves Fusor phone ${payload.phone}`
    );
  }
};

const isEventFromCurrentAccount = (
  event: Pick<DedicatedImessageEvent, "actor" | "isFromMe">,
  phone: string
): boolean =>
  event.isFromMe ||
  (event.actor?.address !== undefined && event.actor.address === phone);

export const handleImessageFusorMessages: HybridFusorMessages<
  ImessageFusorPayload,
  IMessageClient,
  z.infer<typeof configSchema>
> = async ({ client, payload, projectConfig }) => {
  const selected = selectClient(client, payload);
  const phone = payload.kind === "dedicated" ? payload.phone : SHARED_PHONE;
  if (payload.event.type === "message.received") {
    const messages = await toInboundMessages(
      selected.client,
      getMessageCache(selected.client),
      payload.event,
      phone
    );
    if (projectConfig?.profile?.imessageSynced === true) {
      const chatGuid = receivedChatGuid(payload.event);
      if (chatGuid) {
        getContactShareTracker(selected.client).maybeShare(chatGuid);
      }
    }
    return messages;
  }

  if (payload.kind !== "dedicated") {
    throw new FusorTerminalError(
      "Legacy iMessage delivery cannot contain supplemental events"
    );
  }

  if (payload.event.type === "message.reactionAdded") {
    if (isEventFromCurrentAccount(payload.event, phone)) {
      return [];
    }
    return await toReactionMessages(
      selected.client,
      getMessageCache(selected.client),
      payload.event,
      phone,
      payload.sourceSequence
    );
  }

  if (payload.event.type === "poll.changed") {
    const pollCache = getPollCache(selected.client);
    cachePollEvent(pollCache, payload.event);
    if (isEventFromCurrentAccount(payload.event, phone)) {
      return [];
    }
    return await toPollDeltaMessages(
      selected.client,
      pollCache,
      payload.event,
      phone
    );
  }

  const actor = groupEventActor(payload.event);
  if (
    isEventFromCurrentAccount(
      { actor, isFromMe: payload.event.isFromMe },
      phone
    )
  ) {
    return [];
  }
  return await toGroupEventMessages(
    selected.client,
    payload.event,
    phone,
    payload.sourceSequence
  );
};
