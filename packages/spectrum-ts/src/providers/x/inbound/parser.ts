import { buildInternalConversationId } from "../conversation-id";

// ---- Shared types ----

interface XUser {
  id?: string;
  id_str?: string;
  name?: string;
  profile_image_url?: string;
  profile_image_url_https?: string;
  screen_name?: string;
  username?: string;
  verified?: boolean;
}

interface XActivityUserEntry {
  data?: XUser;
}

interface ParsedUser {
  id: string;
  name?: string;
  profileImageUrl?: string;
  username?: string;
  verified: boolean;
}

export type ParsedDirection = "inbound" | "outbound" | "unknown";

export interface ParsedWebhookEvent {
  conversationId: string;
  createdAt?: Date;
  direction: ParsedDirection;
  encodedEvent?: string;
  eventId: string;
  mediaId?: string;
  recipient: ParsedUser;
  sender: ParsedUser;
  text: string;
}

// ---- Shared helpers ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toDirection = (
  forUserId: string | undefined,
  senderId: string
): ParsedDirection => {
  if (!forUserId) {
    return "unknown";
  }
  return senderId === forUserId ? "outbound" : "inbound";
};

// ---- dm.received + legacy Account Activity handler ----

interface XDirectMessage {
  created_timestamp?: string;
  id?: string;
  message_create?: {
    sender_id?: string;
    target?: { recipient_id?: string };
    message_data?: {
      text?: string;
      attachment?: {
        media?: {
          id?: string;
        };
      };
    };
  };
  type?: string;
}

interface XWebhookPayload {
  direct_message_events?: XDirectMessage[];
  for_user_id?: string;
  users?: Record<string, XUser | XActivityUserEntry>;
}

interface XDmReceivedEnvelope {
  data?: {
    event_type?: string;
    filter?: { user_id?: string };
    payload?: {
      direct_message_events?: XDirectMessage[];
      users?: Record<string, XUser | XActivityUserEntry>;
    };
  };
}

const DM_RECEIVED_EVENT_TYPE = "dm.received";

const resolveUserEntry = (
  entry: XUser | XActivityUserEntry | undefined
): XUser | undefined => {
  if (!(entry && typeof entry === "object")) {
    return;
  }
  if ("data" in entry && entry.data && typeof entry.data === "object") {
    return entry.data;
  }
  return entry as XUser;
};

const normalizeUsers = (
  users: Record<string, XUser | XActivityUserEntry> | undefined
): Record<string, XUser> | undefined => {
  if (!users) {
    return;
  }
  const normalized: Record<string, XUser> = {};
  for (const [userId, entry] of Object.entries(users)) {
    const resolved = resolveUserEntry(entry);
    if (resolved) {
      normalized[userId] = resolved;
    }
  }
  return normalized;
};

const toDmUser = (payload: XWebhookPayload, userId: string): ParsedUser => {
  const known = resolveUserEntry(payload.users?.[userId]);
  return {
    id: known?.id ?? known?.id_str ?? userId,
    username: known?.username ?? known?.screen_name,
    name: known?.name,
    profileImageUrl: known?.profile_image_url_https ?? known?.profile_image_url,
    verified: known?.verified ?? false,
  };
};

const toDate = (createdTimestamp: string | undefined): Date | undefined => {
  if (!createdTimestamp) {
    return;
  }
  const asNumber = Number.parseInt(createdTimestamp, 10);
  if (!Number.isFinite(asNumber)) {
    return;
  }
  return new Date(asNumber);
};

const normalizeDmReceivedEnvelope = (
  body: Record<string, unknown>
): XWebhookPayload | null => {
  const envelope = body as XDmReceivedEnvelope;
  const data = envelope.data;
  if (!data || data.event_type !== DM_RECEIVED_EVENT_TYPE) {
    return null;
  }
  const payload = data.payload;
  if (!(payload && Array.isArray(payload.direct_message_events))) {
    return null;
  }
  return {
    for_user_id: data.filter?.user_id,
    users: normalizeUsers(payload.users),
    direct_message_events: payload.direct_message_events,
  };
};

const normalizeLegacyPayload = (
  body: Record<string, unknown>
): XWebhookPayload | null => {
  const payload = body as XWebhookPayload;
  if (!Array.isArray(payload.direct_message_events)) {
    return null;
  }
  return {
    for_user_id: payload.for_user_id,
    users: normalizeUsers(payload.users),
    direct_message_events: payload.direct_message_events,
  };
};

/**
 * Parse legacy Account Activity and Activity API `dm.received` webhook bodies
 * into normalized DM events.
 */
export const parseDmReceivedEvents = (body: unknown): ParsedWebhookEvent[] => {
  if (!isRecord(body)) {
    return [];
  }

  const payload =
    normalizeDmReceivedEnvelope(body) ?? normalizeLegacyPayload(body);
  if (!payload?.direct_message_events) {
    return [];
  }

  const parsedEvents: ParsedWebhookEvent[] = [];
  for (const dm of payload.direct_message_events) {
    if (dm.type && dm.type !== "message_create") {
      continue;
    }

    const senderId = dm.message_create?.sender_id;
    const recipientId =
      dm.message_create?.target?.recipient_id ?? payload.for_user_id;
    if (!(senderId && recipientId)) {
      continue;
    }

    const eventId =
      dm.id ?? `${senderId}:${recipientId}:${dm.created_timestamp ?? "0"}`;
    parsedEvents.push({
      eventId,
      conversationId: buildInternalConversationId(senderId, recipientId),
      sender: toDmUser(payload, senderId),
      recipient: toDmUser(payload, recipientId),
      text: dm.message_create?.message_data?.text ?? "",
      mediaId: dm.message_create?.message_data?.attachment?.media?.id,
      createdAt: toDate(dm.created_timestamp),
      direction: toDirection(payload.for_user_id, senderId),
    });
  }

  return parsedEvents;
};

// ---- chat.received handler ----

interface XChatReceivedPayload {
  conversation_id?: string;
  created_at_msec?: string;
  encoded_event?: string;
  id?: string;
  sender_id?: string;
}

interface XChatReceivedEnvelope {
  data?: {
    event_type?: string;
    filter?: { user_id?: string };
    payload?: XChatReceivedPayload;
  };
}

const CHAT_RECEIVED_EVENT_TYPE = "chat.received";

/**
 * Parse Activity API `chat.received` webhook bodies. The message content is
 * binary-encoded in `encoded_event` and cannot be decoded without the schema;
 * `text` is always empty and `encodedEvent` carries the raw base64 blob.
 */
export const parseChatReceivedEvents = (
  body: unknown
): ParsedWebhookEvent[] => {
  if (!isRecord(body)) {
    return [];
  }

  const envelope = body as XChatReceivedEnvelope;
  const data = envelope.data;
  if (!data || data.event_type !== CHAT_RECEIVED_EVENT_TYPE) {
    return [];
  }

  const payload = data.payload;
  if (!payload) {
    return [];
  }

  const eventId = payload.id;
  const senderId = payload.sender_id;
  const rawConversationId = payload.conversation_id;
  const forUserId = data.filter?.user_id;

  if (!(eventId && senderId && rawConversationId)) {
    return [];
  }

  const [partA, partB] = rawConversationId.split(":");
  const recipientId =
    (partA === senderId ? partB : partA) ?? forUserId ?? senderId;

  const createdAt = payload.created_at_msec
    ? new Date(Number(payload.created_at_msec))
    : undefined;

  const event: ParsedWebhookEvent = {
    eventId,
    conversationId: buildInternalConversationId(senderId, recipientId),
    sender: { id: senderId, verified: false },
    recipient: { id: recipientId, verified: false },
    text: "",
    direction: toDirection(forUserId, senderId),
    createdAt,
  };

  if (payload.encoded_event) {
    event.encodedEvent = payload.encoded_event;
  }

  return [event];
};

// ---- Main export ----

/**
 * Parse incoming X webhook bodies into normalized events. Tries `dm.received`
 * and legacy Account Activity format first, then `chat.received`.
 */
export const parseWebhookPayload = (body: unknown): ParsedWebhookEvent[] => {
  const dmEvents = parseDmReceivedEvents(body);
  if (dmEvents.length > 0) {
    return dmEvents;
  }
  return parseChatReceivedEvents(body);
};
