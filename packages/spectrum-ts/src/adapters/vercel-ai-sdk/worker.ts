import {
  defaultChatUser,
  isSpectrumChatUser,
  parseChatRequest,
  spaceIdForUser,
} from "./request";
import { loadAiRuntime } from "./stream";
import type {
  CreateSpectrumWorkerBridgeOptions,
  SpectrumChatUser,
} from "./types";

const BAD_REQUEST_STATUS = 400;
const CLIENT_CLOSED_REQUEST_STATUS = 499;
const GATEWAY_TIMEOUT_STATUS = 504;
const INTERNAL_SERVER_ERROR_STATUS = 500;
const UNAUTHORIZED_STATUS = 401;
const DEFAULT_TIMEOUT_MS = 30_000;

type BridgeEvent =
  | { requestId: string; type: "text_start" }
  | { delta: string; requestId: string; type: "text_delta" }
  | { requestId: string; type: "text_end" }
  | { message: string; requestId: string; type: "error" };

interface WorkerBridgeRequest {
  messageId: string;
  metadata: unknown;
  requestId: string;
  responseSessionId: string;
  spaceId: string;
  text: string;
  userId: string;
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: BAD_REQUEST_STATUS });
}

function internalServerError(message: string): Response {
  return Response.json(
    { error: message },
    { status: INTERNAL_SERVER_ERROR_STATUS }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveUser<User extends SpectrumChatUser>(
  options: CreateSpectrumWorkerBridgeOptions<User>,
  request: Request
): Promise<Response | User> {
  const user = options.getUser
    ? await options.getUser(request)
    : (defaultChatUser() as User);
  if (user === null) {
    return Response.json(
      { error: "Unauthorized." },
      { status: UNAUTHORIZED_STATUS }
    );
  }
  if (!isSpectrumChatUser(user)) {
    return internalServerError(
      "getUser(request) must return a user object with a non-empty string id."
    );
  }
  return user;
}

async function parseRequestBody(request: Request): Promise<Response | unknown> {
  try {
    return await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
}

function parseBridgeEvent(value: unknown): BridgeEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Worker stream emitted a malformed bridge event.");
  }
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    throw new Error("Worker stream event is missing requestId.");
  }

  if (value.type === "text_start" || value.type === "text_end") {
    return { type: value.type, requestId: value.requestId };
  }
  if (value.type === "text_delta" && typeof value.delta === "string") {
    return {
      type: "text_delta",
      requestId: value.requestId,
      delta: value.delta,
    };
  }
  if (value.type === "error" && typeof value.message === "string") {
    return {
      type: "error",
      requestId: value.requestId,
      message: value.message,
    };
  }

  throw new Error(`Worker stream emitted unsupported event "${value.type}".`);
}

async function* readNdjsonEvents(
  body: ReadableStream<Uint8Array>
): AsyncIterable<BridgeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield parseBridgeEvent(JSON.parse(line) as unknown);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) {
      yield parseBridgeEvent(JSON.parse(tail) as unknown);
    }
  } finally {
    reader.releaseLock();
  }
}

function timeoutSignal(timeoutMs: number, requestSignal: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort(requestSignal.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Worker bridge request timed out."));
  }, timeoutMs);
  timer.unref?.();
  requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  };
}

function workerFetchErrorResponse(
  request: Request,
  timeout: ReturnType<typeof timeoutSignal>
): Response | undefined {
  if (request.signal.aborted) {
    return Response.json(
      { error: "Request was aborted." },
      { status: CLIENT_CLOSED_REQUEST_STATUS }
    );
  }
  if (timeout.timedOut()) {
    return Response.json(
      { error: "Worker bridge request timed out." },
      { status: GATEWAY_TIMEOUT_STATUS }
    );
  }
}

async function fetchWorkerResponse(options: {
  apiKey?: string;
  payload: WorkerBridgeRequest;
  signal: AbortSignal;
  workerUrl: string;
}): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.apiKey) {
    headers.set("authorization", `Bearer ${options.apiKey}`);
  }

  return await fetch(options.workerUrl, {
    body: JSON.stringify(options.payload),
    headers,
    method: "POST",
    signal: options.signal,
  });
}

function writeBridgeEvent(options: {
  bridgeRequestId: string;
  event: BridgeEvent;
  textPartId: string;
  writer: { write(part: unknown): void };
}): void {
  const { bridgeRequestId, event, textPartId, writer } = options;
  if (event.requestId !== bridgeRequestId) {
    throw new Error(
      "Worker stream event requestId did not match the current request."
    );
  }

  if (event.type === "text_start") {
    writer.write({ type: "text-start", id: textPartId });
    return;
  }
  if (event.type === "text_delta") {
    writer.write({ type: "text-delta", id: textPartId, delta: event.delta });
    return;
  }
  if (event.type === "text_end") {
    writer.write({ type: "text-end", id: textPartId });
    return;
  }
  throw new Error(event.message);
}

async function streamWorkerEvents(options: {
  bridgeRequestId: string;
  body: ReadableStream<Uint8Array>;
  requestSignal: AbortSignal;
  textPartId: string;
  timeout: ReturnType<typeof timeoutSignal>;
  writer: { write(part: unknown): void };
}): Promise<void> {
  const { body, requestSignal, timeout, ...writeOptions } = options;
  try {
    for await (const event of readNdjsonEvents(body)) {
      if (requestSignal.aborted) {
        return;
      }
      writeBridgeEvent({ ...writeOptions, event });
    }
  } finally {
    timeout.cleanup();
  }
}

/**
 * Creates a Next.js-compatible `POST` handler that forwards one useChat request
 * to a separate Spectrum worker over NDJSON HTTP streaming.
 *
 * The handler is intentionally request-scoped: it never imports `Spectrum()`,
 * registers providers, or starts persistent listeners. The long-running worker
 * owns `app.messages` and sends replies back through request-specific bridge
 * sessions.
 */
export function createSpectrumWorkerBridge<
  User extends SpectrumChatUser = SpectrumChatUser,
>(
  options: CreateSpectrumWorkerBridgeOptions<User>
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.signal.aborted) {
      return Response.json(
        { error: "Request was aborted." },
        { status: CLIENT_CLOSED_REQUEST_STATUS }
      );
    }

    const user = await resolveUser(options, request);
    if (user instanceof Response) {
      return user;
    }

    const body = await parseRequestBody(request);
    if (body instanceof Response) {
      return body;
    }

    const parsed = parseChatRequest(body);
    if ("error" in parsed) {
      return badRequest(parsed.error);
    }

    const timeout = timeoutSignal(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      request.signal
    );
    const bridgeRequestId = crypto.randomUUID();
    const responseSessionId = crypto.randomUUID();
    const workerPayload: WorkerBridgeRequest = {
      messageId: parsed.requestId,
      metadata: parsed.metadata,
      requestId: bridgeRequestId,
      responseSessionId,
      spaceId: spaceIdForUser(user, parsed.conversationId),
      text: parsed.text,
      userId: user.id,
    };

    let workerResponse: Response;
    try {
      workerResponse = await fetchWorkerResponse({
        apiKey: options.apiKey,
        payload: workerPayload,
        signal: timeout.signal,
        workerUrl: options.workerUrl,
      });
    } catch (cause) {
      timeout.cleanup();
      const errorResponse = workerFetchErrorResponse(request, timeout);
      if (errorResponse) {
        return errorResponse;
      }
      throw cause;
    }

    if (!workerResponse.ok) {
      timeout.cleanup();
      return Response.json(
        { error: "Worker bridge request failed." },
        { status: workerResponse.status }
      );
    }
    const workerBody = workerResponse.body;
    if (!workerBody) {
      timeout.cleanup();
      return internalServerError(
        "Worker bridge response did not include a body."
      );
    }

    const { createUIMessageStream, createUIMessageStreamResponse } =
      await loadAiRuntime();
    const textPartId = `${bridgeRequestId}-text`;
    const stream = createUIMessageStream({
      execute: ({ writer }) =>
        streamWorkerEvents({
          body: workerBody,
          bridgeRequestId,
          requestSignal: request.signal,
          textPartId,
          timeout,
          writer,
        }),
    });

    return createUIMessageStreamResponse({ stream });
  };
}
