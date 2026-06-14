import type { XEffectiveConfig } from "../config";

interface XApiErrorPayload {
  detail?: string;
  errors?: unknown[];
  message?: string;
  title?: string;
}

const authHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
});

const extractXErrorMessage = (status: number, payload: unknown): string => {
  if (!(payload && typeof payload === "object")) {
    return `X API error: ${status}`;
  }
  const body = payload as XApiErrorPayload;
  if (Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      if (!(entry && typeof entry === "object")) {
        continue;
      }
      const e = entry as XApiErrorPayload;
      const fromEntry = e.detail ?? e.message ?? e.title;
      if (fromEntry) {
        return fromEntry;
      }
    }
  }
  const detail = body.detail ?? body.title ?? body.message;
  return detail ?? `X API error: ${status}`;
};

/**
 * Fetch from the X API using provided access token and headers.
 * @param url - The URL to fetch from.
 * @param accessToken - The access token to use for authentication. This is the user-context OAuth token used for outbound DM sends and account webhook subscription.
 * @param init - The init object to use for the fetch. This is the init object to use for the fetch.
 * @returns The body of the response. This is the body of the response from the X API.
 */
const xApiFetch = async (
  url: string,
  accessToken: string,
  init: RequestInit
): Promise<unknown> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(accessToken),
      ...(init.headers as Record<string, string>),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(extractXErrorMessage(response.status, body));
  }
  return body;
};

export interface XCreateDmBody {
  attachments?: Array<{ media_id: string }>;
  text?: string;
}

export interface SendDmByParticipantResult {
  dmConversationId: string;
  dmEventId: string;
}

/**
 * Send a DM to a participant via `POST /2/dm_conversations/with/:id/messages`.
 * Returns the conversation and event ids from the X API response.
 */
export const sendDmByParticipantId = async (
  config: Pick<XEffectiveConfig, "accessToken" | "baseUrl">,
  participantId: string,
  body: XCreateDmBody
): Promise<SendDmByParticipantResult> => {
  const payload = (await xApiFetch(
    `${config.baseUrl}/2/dm_conversations/with/${encodeURIComponent(participantId)}/messages`,
    config.accessToken,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  )) as {
    data?: {
      dm_conversation_id?: string;
      dm_event_id?: string;
    };
  };

  const dmConversationId = payload.data?.dm_conversation_id;
  const dmEventId = payload.data?.dm_event_id;
  if (!(dmConversationId && dmEventId)) {
    throw new Error(
      "X API response is missing dm_conversation_id or dm_event_id"
    );
  }
  return { dmConversationId, dmEventId };
};
