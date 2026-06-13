import { buildInternalConversationId } from "../conversation-id";

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

interface XActivityWebhookEnvelope {
  data?: {
    event_type?: string;
    filter?: { user_id?: string };
    payload?: {
      direct_message_events?: XDirectMessage[];
      users?: Record<string, XUser | XActivityUserEntry>;
    };
  };
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
  eventId: string;
  mediaId?: string;
  recipient: ParsedUser;
  sender: ParsedUser;
  text: string;
}

const DM_RECEIVED_EVENT_TYPE = "dm.received";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

const normalizeActivityEnvelope = (
  body: Record<string, unknown>
): XWebhookPayload | null => {
  const envelope = body as XActivityWebhookEnvelope;
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

const normalizeWebhookPayload = (body: unknown): XWebhookPayload | null => {
  if (!isRecord(body)) {
    return null;
  }
  return normalizeActivityEnvelope(body) ?? normalizeLegacyPayload(body);
};

const toUser = (payload: XWebhookPayload, userId: string): ParsedUser => {
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

const toDirection = (
  forUserId: string | undefined,
  senderId: string
): ParsedDirection => {
  if (!forUserId) {
    return "unknown";
  }
  if (senderId === forUserId) {
    return "outbound";
  }
  return "inbound";
};

/**
 * Parse legacy Account Activity and Activity API (`dm.received`) webhook bodies
 * into normalized DM events. Non-message event types and malformed entries are
 * skipped; direction is inferred from `for_user_id` vs sender.
 */
export const parseWebhookPayload = (body: unknown): ParsedWebhookEvent[] => {
  const payload = normalizeWebhookPayload(body);
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
      sender: toUser(payload, senderId),
      recipient: toUser(payload, recipientId),
      text: dm.message_create?.message_data?.text ?? "",
      mediaId: dm.message_create?.message_data?.attachment?.media?.id,
      createdAt: toDate(dm.created_timestamp),
      direction: toDirection(payload.for_user_id, senderId),
    });
  }

  return parsedEvents;
};
