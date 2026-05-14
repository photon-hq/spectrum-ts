import type { VercelAiSdkUIConfig } from "./config";

// Request parsing is intentionally narrow: Phase 1 accepts AI SDK useChat's
// text parts only and maps them into a single Spectrum text message.
export interface ParsedChatRequest {
  id: string;
  spaceId: string;
  text: string;
  userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function userIdFromBody(
  body: Record<string, unknown>,
  fallback: string
): string {
  // Support both metadata keys seen in AI SDK transports without coupling
  // Spectrum to a frontend-specific auth shape.
  const metadata = isRecord(body.metadata) ? body.metadata : undefined;
  const requestMetadata = isRecord(body.requestMetadata)
    ? body.requestMetadata
    : undefined;
  return (
    stringValue(metadata?.userId) ??
    stringValue(requestMetadata?.userId) ??
    fallback
  );
}

function extractText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }
  const textParts: string[] = [];
  for (const part of message.parts) {
    if (!isRecord(part)) {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    }
  }
  return textParts.join("");
}

export function parseChatRequest(
  body: unknown,
  config: VercelAiSdkUIConfig
): ParsedChatRequest | { error: string } {
  if (!(isRecord(body) && Array.isArray(body.messages))) {
    return { error: "Request body must include a messages array." };
  }

  let latestUserMessage: Record<string, unknown> | undefined;
  for (const message of [...body.messages].reverse()) {
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === "user") {
      latestUserMessage = message;
      break;
    }
  }

  if (!latestUserMessage) {
    return { error: "Request body must include a user message." };
  }

  const text = extractText(latestUserMessage);
  if (text.length === 0) {
    return { error: "Latest user message must include text content." };
  }

  return {
    id: stringValue(latestUserMessage.id) ?? crypto.randomUUID(),
    spaceId:
      stringValue(body.id) ?? stringValue(body.chatId) ?? config.defaultSpaceId,
    text,
    userId: userIdFromBody(body, config.defaultUserId),
  };
}
