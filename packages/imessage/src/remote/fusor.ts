import {
  decodeCatchUpEvent,
  type GroupEvent,
  type MessageEvent,
  type PollEvent,
} from "@photon-ai/advanced-imessage/http";
import {
  FusorRetryableError,
  FusorTerminalError,
  type FusorVerifyRequest,
  type HybridFusorMessages,
  type ProjectData,
} from "@spectrum-ts/core";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";
import type z from "zod";
import { getCloudRecover } from "../auth";
import { getMessageCache, getPollCache } from "../cache";
import type { IMessageClient, RemoteClient } from "../types";
import { type configSchema, SHARED_PHONE } from "../types";
import { inspectCatchUpSequence } from "./catchup-sequence";
import { clientEntryForPhone, isSharedMode } from "./client";
import { getContactShareTracker } from "./contact-share";
import { groupEventActor, toGroupEventMessages } from "./group-events";
import { type ReceivedEvent, toInboundMessages } from "./inbound";
import { cachePollEvent, toPollDeltaMessages } from "./polls";
import { getProfileSyncGate } from "./profile-sync-gate";
import { toReactionMessages } from "./reactions";
import { toReadReceiptMessages } from "./read-receipts";

const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
type LegacyTransformVersion = "1" | "2" | "3";
type LegacyEventType = "messageChanged" | "pollChanged";
type ReactionAddedEvent = Extract<
  MessageEvent,
  { type: "message.reactionAdded" }
>;
type ReadEvent = Extract<MessageEvent, { type: "message.read" }>;
type LegacyImessageEvent = MessageEvent | PollEvent;
type DedicatedImessageEvent =
  | GroupEvent
  | PollEvent
  | ReactionAddedEvent
  | ReadEvent
  | ReceivedEvent;

const DEDICATED_EVENT_TYPES = {
  groupChanged: "group.changed",
  messageChanged: "message.received",
  messageRead: "message.read",
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
const log = createLogger("spectrum.imessage.fusor");

// Explicit retry markers must reach Fusor so it retains and replays the event.
// Other mapping failures are deterministic poison frames; retrying one would
// block the project-wide cursor and every line behind it indefinitely.
const isRetryableMappingError = (error: unknown): boolean =>
  error instanceof FusorRetryableError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === true);

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

const assertVirtualMessageEventResources = (event: MessageEvent): void => {
  if (event.type === "message.received") {
    assertVirtualImessageResources(event);
    return;
  }

  assertVirtualGuid(event.messageGuid, "spc-msg-", `${event.type}.messageGuid`);
  if (event.type === "message.edited") {
    for (const [index, attachment] of event.content.attachments.entries()) {
      assertVirtualAttachment(
        attachment,
        `${event.type}.content.attachments[${index}]`
      );
    }
    return;
  }
  if (event.type === "message.stickerPlaced" && event.sticker) {
    assertVirtualAttachment(event.sticker, `${event.type}.sticker`);
  }
};

const assertVirtualLegacyEventResources = (
  event: LegacyImessageEvent
): void => {
  if (event.type === "poll.changed") {
    assertVirtualGuid(
      event.pollMessageGuid,
      "spc-msg-",
      "poll.changed.pollMessageGuid"
    );
    return;
  }
  assertVirtualMessageEventResources(event);
};

interface LegacyImessageFusorPayload {
  event: LegacyImessageEvent | undefined;
  eventType: LegacyEventType;
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

const decodeLegacyV3Event = (
  rawBody: Uint8Array,
  sourceSequence: string,
  eventType: LegacyEventType
): LegacyImessageEvent | undefined => {
  const decoded = decodeEvent(rawBody, sourceSequence);
  if (decoded === undefined) {
    return;
  }
  const isExpectedMessage =
    eventType === "messageChanged" && decoded.type.startsWith("message.");
  const isExpectedPoll =
    eventType === "pollChanged" && decoded.type === "poll.changed";
  if (!(isExpectedMessage || isExpectedPoll)) {
    throw new Error("Invalid iMessage Fusor event payload");
  }
  const event = decoded as LegacyImessageEvent;
  assertVirtualLegacyEventResources(event);
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

const isLegacyEventType = (value: string): value is LegacyEventType =>
  value === "messageChanged" || value === "pollChanged";

const parseLegacyPayload = (
  request: FusorVerifyRequest,
  transformVersion: LegacyTransformVersion
): LegacyImessageFusorPayload => {
  const eventType = requireHeader(request, "x-fusor-imessage-event-type");
  if (
    !isLegacyEventType(eventType) ||
    (transformVersion !== "3" && eventType !== "messageChanged")
  ) {
    throw new Error("Invalid iMessage Fusor event type");
  }
  assertEventContract(request, eventType);
  const sourceSequence = requireHeader(request, "x-fusor-imessage-log-id");
  if (!POSITIVE_INTEGER_RE.test(sourceSequence)) {
    throw new Error("Invalid iMessage Fusor source log id");
  }
  const event =
    transformVersion === "3"
      ? decodeLegacyV3Event(request.rawBody, sourceSequence, eventType)
      : decodeReceivedEvent(request.rawBody, sourceSequence);
  if (transformVersion !== "3") {
    assertVirtualImessageResources(event as ReceivedEvent);
  }
  return {
    event,
    eventType,
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

const selectClient = async (
  clients: IMessageClient,
  payload: ImessageFusorPayload
): Promise<RemoteClient> => {
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
    const recover = getCloudRecover(clients);
    if (!recover) {
      throw new FusorTerminalError(
        `No iMessage client serves Fusor phone ${payload.phone}`
      );
    }
    const inventoryIsFresh = await recover();
    if (!inventoryIsFresh) {
      throw new FusorRetryableError(
        `iMessage line discovery is waiting to refresh phone ${payload.phone}`
      );
    }
    try {
      return clientEntryForPhone(clients, payload.phone);
    } catch {
      throw new FusorTerminalError(
        `No iMessage client serves Fusor phone ${payload.phone} after Cloud refresh`
      );
    }
  }
};

const isEventFromCurrentAccount = (
  event: Pick<DedicatedImessageEvent, "actor" | "isFromMe">,
  phone: string
): boolean =>
  event.isFromMe ||
  (event.actor?.address !== undefined && event.actor.address === phone);

const maybeShareWhenProfileSynced = (
  clients: IMessageClient,
  selected: RemoteClient,
  projectConfig: ProjectData | undefined,
  chatGuid: string
): void => {
  const tracker = getContactShareTracker(selected.client);
  if (tracker.hasRecentlyShared(chatGuid)) {
    return;
  }

  const gate = getProfileSyncGate(clients);
  if (!gate) {
    if (projectConfig?.profile?.imessageSynced === true) {
      tracker.maybeShare(chatGuid);
    }
    return;
  }

  gate
    .isEnabled()
    .then((enabled) => {
      if (enabled) {
        tracker.maybeShare(chatGuid);
      }
    })
    .catch((error: unknown) => {
      log.warn(
        "profile sync gate failed; skipping automatic contact sharing",
        errorAttrs(error),
        error instanceof Error ? error : undefined
      );
    });
};

const mapImessageFusorEvent = async (
  clients: IMessageClient,
  selected: RemoteClient,
  payload: ImessageFusorPayload,
  projectConfig: ProjectData | undefined,
  phone: string
) => {
  if (payload.event === undefined) {
    return [];
  }
  if (payload.event.type === "message.received") {
    if (payload.event.isFromMe || payload.event.message.isFromMe) {
      return [];
    }
    const messages = await toInboundMessages(
      selected.client,
      getMessageCache(selected.client),
      payload.event,
      phone
    );
    const chatGuid = receivedChatGuid(payload.event);
    if (chatGuid) {
      maybeShareWhenProfileSynced(clients, selected, projectConfig, chatGuid);
    }
    return messages;
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

  if (payload.event.type === "message.read") {
    return await toReadReceiptMessages(
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

  if (payload.kind !== "dedicated") {
    return [];
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

export const handleImessageFusorMessages: HybridFusorMessages<
  ImessageFusorPayload,
  IMessageClient,
  z.infer<typeof configSchema>
> = async ({ client, payload, projectConfig }) => {
  const selected = await selectClient(client, payload);
  const phone = payload.kind === "dedicated" ? payload.phone : SHARED_PHONE;
  try {
    return await mapImessageFusorEvent(
      client,
      selected,
      payload,
      projectConfig,
      phone
    );
  } catch (error) {
    if (isRetryableMappingError(error)) {
      throw error;
    }
    log.warn(
      "skipping unmappable imessage Fusor event",
      {
        "spectrum.imessage.event_type": payload.event?.type ?? "no-op",
        "spectrum.imessage.source_sequence": payload.sourceSequence,
        ...errorAttrs(error),
      },
      error instanceof Error ? error : undefined
    );
    return [];
  }
};
