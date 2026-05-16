import z from "zod";
import { asText } from "../../content/text";
import type { ProviderMessage } from "../../platform/types";
import type { WebChatUser } from "./config";

const textPartSchema = z.object({
  text: z.string(),
  type: z.literal("text"),
});

const uiMessageSchema = z.object({
  id: z.string().min(1),
  parts: z.array(z.unknown()),
  role: z.string(),
});

export const webChatRequestSchema = z.object({
  agentId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  messages: z.array(uiMessageSchema),
  metadata: z.unknown().optional(),
  requestId: z.string().min(1),
  submittedMessageId: z.string().min(1),
  trigger: z.enum(["submit-message", "regenerate-message"]),
});

export type WebChatRequest = z.infer<typeof webChatRequestSchema>;

export type WebChatMessage = ProviderMessage<
  { id: string },
  {
    agentId?: string;
    conversationId: string;
    id: string;
    idempotencyKey: string;
    requestId: string;
    submittedMessageId: string;
    userId: string;
  },
  { request: WebChatRequest; user: WebChatUser }
>;

export class WebChatRequestError extends Error {
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly status: number;
  readonly type: string;

  constructor(options: {
    message: string;
    requestId?: string;
    retryable?: boolean;
    status: number;
    type: string;
  }) {
    super(options.message);
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.type = options.type;
  }
}

// `useChat` sends full conversation history. The provider must turn only the
// explicitly submitted message into a new Spectrum inbound message.
function submittedText(request: WebChatRequest): string {
  const message = request.messages.find(
    (candidate) => candidate.id === request.submittedMessageId
  );

  if (!message) {
    throw new WebChatRequestError({
      message: "Submitted message was not present in messages.",
      requestId: request.requestId,
      status: 400,
      type: "invalid_submitted_message",
    });
  }

  const parts = message.parts
    .map((part) => textPartSchema.safeParse(part))
    .filter((result) => result.success)
    .map((result) => result.data.text);
  const text = parts.join("");

  if (!text.trim()) {
    throw new WebChatRequestError({
      message: "Submitted message did not include text content.",
      requestId: request.requestId,
      status: 400,
      type: "unsupported_submitted_message",
    });
  }

  return text;
}

/**
 * Converts one validated AI SDK request envelope into one Spectrum provider
 * message. Browser-provided metadata is preserved for app code, but trusted
 * identity comes only from the server-side `WebChatUser` resolved by auth.
 */
export function toWebChatMessage({
  request,
  user,
}: {
  request: WebChatRequest;
  user: WebChatUser;
}): WebChatMessage {
  const conversationId = request.conversationId ?? request.id;

  return {
    content: asText(submittedText(request)),
    id: request.submittedMessageId,
    request,
    sender: { ...user.metadata, id: user.id },
    space: {
      agentId: request.agentId,
      conversationId,
      id: `web:${user.id}:${conversationId}`,
      idempotencyKey: request.idempotencyKey,
      requestId: request.requestId,
      submittedMessageId: request.submittedMessageId,
      userId: user.id,
    },
    timestamp: new Date(),
    user,
  };
}
