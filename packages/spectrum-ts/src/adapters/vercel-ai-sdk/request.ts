import type { UIMessage } from "ai";
import z from "zod";
import type { SpectrumChatUser } from "./types";

const DEFAULT_CONVERSATION_ID = "default";
const DEFAULT_USER_ID = "web-user";

const chatMessageSchema = z
  .object({
    id: z.string().min(1).optional(),
    parts: z.array(z.unknown()).optional(),
    role: z.string(),
  })
  .passthrough();

const chatRequestBodySchema = z
  .object({
    chatId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    messages: z.array(chatMessageSchema),
    metadata: z.unknown().optional(),
    requestMetadata: z.unknown().optional(),
  })
  .passthrough();

const spectrumChatUserSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

type ChatMessageInput = z.infer<typeof chatMessageSchema>;

export interface ParsedChatRequest {
  conversationId: string;
  message: UIMessage;
  messages: UIMessage[];
  metadata: unknown;
  requestId: string;
  text: string;
}

export function defaultChatUser(): SpectrumChatUser {
  return { id: DEFAULT_USER_ID };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts the text payload from an AI SDK UI message.
 *
 * The adapter is text-only in Phase 2A, but useChat messages can contain files,
 * tool parts, and other UI parts. This helper keeps the supported text parts in
 * order and ignores everything else instead of treating non-text parts as
 * request text.
 */
function textFromMessage(message: Record<string, unknown>): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }

  const parts: string[] = [];
  for (const part of message.parts) {
    if (!isRecord(part)) {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }

  return parts.join("");
}

/**
 * Reads caller-supplied request metadata without committing to one transport
 * option name. AI SDK transports commonly use either metadata or
 * requestMetadata, and both should stay at the HTTP boundary.
 */
function metadataFromBody(body: Record<string, unknown>): unknown {
  return body.metadata ?? body.requestMetadata;
}

/**
 * Parses the single useChat POST body handled by this request.
 *
 * useChat sends the full transcript, but this request-scoped adapter should
 * only treat the latest user message as the current input. The complete
 * messages array is still preserved in the returned context for applications
 * that want history-aware responses.
 */
export function parseChatRequest(
  body: unknown
): ParsedChatRequest | { error: string } {
  const parsedBody = chatRequestBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return { error: "Request body must include a messages array." };
  }
  const data = parsedBody.data;

  let latestUserMessage: ChatMessageInput | undefined;
  for (const message of [...data.messages].reverse()) {
    if (message.role === "user") {
      latestUserMessage = message;
      break;
    }
  }

  if (!latestUserMessage) {
    return { error: "Request body must include a user message." };
  }

  const text = textFromMessage(latestUserMessage);
  if (text.length === 0) {
    return { error: "Latest user message must include text content." };
  }

  return {
    conversationId: data.id ?? data.chatId ?? DEFAULT_CONVERSATION_ID,
    message: latestUserMessage as unknown as UIMessage,
    messages: data.messages as UIMessage[],
    metadata: metadataFromBody(data),
    requestId: data.messageId ?? latestUserMessage.id ?? crypto.randomUUID(),
    text,
  };
}

/**
 * Validates the runtime value returned by `getUser(...)`.
 *
 * The TypeScript type protects application source, but auth adapters often
 * deserialize external session data. Future worker/thread mapping depends on a
 * stable non-empty user id, so validate the shape before building any ids.
 */
export function isSpectrumChatUser(value: unknown): value is SpectrumChatUser {
  return spectrumChatUserSchema.safeParse(value).success;
}

/**
 * Builds the Spectrum-ish web space identity for this request.
 *
 * `conversationId` alone is not globally unique: two different authenticated
 * users can both have the same useChat id or default id. Namespacing by user id
 * gives Phase 2B a stable bridge key without starting the worker bridge here.
 */
export function spaceIdForUser(
  user: SpectrumChatUser,
  conversationId: string
): string {
  return `web:${encodeURIComponent(user.id)}:${encodeURIComponent(conversationId)}`;
}
