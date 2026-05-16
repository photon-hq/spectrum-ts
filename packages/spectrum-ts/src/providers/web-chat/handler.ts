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
  cors?: {
    origins: string[];
  };
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

function allowedOrigin(
  request: Request,
  cors: WebChatHandlerOptions["cors"]
): string | undefined {
  const origin = request.headers.get("origin");
  if (!(origin && cors)) {
    return;
  }
  return cors.origins.includes("*") || cors.origins.includes(origin)
    ? origin
    : undefined;
}

function corsHeaders(
  request: Request,
  cors: WebChatHandlerOptions["cors"]
): Headers {
  const headers = new Headers();
  const origin = allowedOrigin(request, cors);
  if (!origin) {
    return headers;
  }

  const requestedHeaders = request.headers.get(
    "access-control-request-headers"
  );
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    requestedHeaders ?? "content-type, authorization"
  );
  headers.set("access-control-max-age", "600");
  headers.set("access-control-expose-headers", "x-vercel-ai-ui-message-stream");
  headers.set("vary", "Origin, Access-Control-Request-Headers");
  return headers;
}

function withCors(
  response: Response,
  request: Request,
  cors: WebChatHandlerOptions["cors"]
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(request, cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
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
    if (request.method === "OPTIONS") {
      // Browsers preflight the AI SDK POST because it sends JSON and may include
      // auth headers. Treat the preflight as transport setup, not an app turn.
      return new Response(null, {
        headers: corsHeaders(request, options.cors),
        status: 204,
      });
    }

    if (request.method !== "POST") {
      return withCors(
        Response.json(
          {
            error: {
              message: "Method not allowed.",
              retryable: false,
              type: "method_not_allowed",
            },
          },
          { status: 405 }
        ),
        request,
        options.cors
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
      return withCors(session.response(), request, options.cors);
    } catch (error) {
      return withCors(errorResponse(error), request, options.cors);
    }
  };
}
