import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  type WebChatUser,
} from "./config";
import {
  toWebChatMessage,
  type WebChatMessage,
  WebChatRequestError,
  webChatRequestSchema,
} from "./request";
import { WebChatSession } from "./session";

export interface WebChatHandlerOptions {
  createSession?: (options: {
    requestId: string;
    signal: AbortSignal;
    timeoutMs: number;
  }) => WebChatSession;
  enqueue: (message: WebChatMessage) => Promise<void> | void;
  hasProcessed?: (key: string) => boolean;
  markProcessed?: (key: string) => void;
  maxBodyBytes?: number;
  resolveUser: (request: Request) => Promise<WebChatUser> | WebChatUser;
  timeoutMs?: number;
}

async function readJson(
  request: Request,
  maxBodyBytes: number
): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    throw new WebChatRequestError({
      message: "Request body is too large.",
      status: 413,
      type: "body_too_large",
    });
  }
  return JSON.parse(text) as unknown;
}

function safeRequestId(body: unknown): string | undefined {
  const result = webChatRequestSchema.pick({ requestId: true }).safeParse(body);
  if (!result.success) {
    return;
  }
  return result.data.requestId;
}

function errorResponse(error: unknown): Response {
  if (error instanceof WebChatRequestError) {
    return Response.json(
      {
        error: {
          message: error.message,
          requestId: error.requestId,
          retryable: error.retryable,
          type: error.type,
        },
      },
      { status: error.status }
    );
  }

  return Response.json(
    {
      error: {
        message: "webChat request failed.",
        retryable: false,
        type: "web_chat_internal_error",
      },
    },
    { status: 500 }
  );
}

/**
 * Builds the reusable webChat request handler used by standalone server mode
 * and future framework adapters.
 *
 * The handler validates the AI SDK request envelope, resolves trusted identity,
 * creates/registers the response session, and enqueues exactly one Spectrum
 * inbound message for the submitted turn.
 */
export function createWebChatHandler(options: WebChatHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json(
        {
          error: {
            message: "Method not allowed.",
            retryable: false,
            type: "method_not_allowed",
          },
        },
        { status: 405 }
      );
    }

    try {
      const body = await readJson(
        request,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
      );
      const parsedResult = webChatRequestSchema.safeParse(body);
      if (!parsedResult.success) {
        throw new WebChatRequestError({
          message: "Invalid webChat request.",
          requestId: safeRequestId(body),
          status: 400,
          type: "invalid_submitted_message",
        });
      }

      const parsed = parsedResult.data;
      const user = await options.resolveUser(request);
      const dedupeKey = `${user.id}:${parsed.id}:${parsed.idempotencyKey}`;
      if (options.hasProcessed?.(dedupeKey)) {
        throw new WebChatRequestError({
          message: "Duplicate submitted turn.",
          requestId: parsed.requestId,
          status: 409,
          type: "duplicate_submitted_turn",
        });
      }

      const session =
        options.createSession?.({
          requestId: parsed.requestId,
          signal: request.signal,
          timeoutMs: options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
        }) ??
        new WebChatSession({
          onClose: () => undefined,
          requestId: parsed.requestId,
          signal: request.signal,
          timeoutMs: options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
        });

      // Queue only after the session exists so a synchronous app.messages
      // consumer can immediately call space.send(...) without losing output.
      await options.enqueue(toWebChatMessage({ request: parsed, user }));
      options.markProcessed?.(dedupeKey);
      return session.response();
    } catch (error) {
      return errorResponse(error);
    }
  };
}
