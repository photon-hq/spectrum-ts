import {
  defaultChatUser,
  isSpectrumChatUser,
  type ParsedChatRequest,
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

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function badRequest(message: string): Response {
  return jsonError(message, BAD_REQUEST_STATUS);
}

function internalServerError(message: string): Response {
  return jsonError(message, INTERNAL_SERVER_ERROR_STATUS);
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
    return jsonError("Unauthorized.", UNAUTHORIZED_STATUS);
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

/**
 * Normalizes one NDJSON line from the worker into the small bridge protocol the
 * route understands before it writes AI SDK UI stream parts.
 */
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

/**
 * Reads newline-delimited JSON from the worker response and yields validated
 * bridge events, preserving partial lines across stream chunks.
 */
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

/**
 * Combines the browser request abort signal with the bridge timeout. The route
 * owns timeoutMs because the worker may be long-running, but each web request
 * still needs a bounded wait for its streamed response.
 */
function createTimeoutSignal(timeoutMs: number, requestSignal: AbortSignal) {
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
  timeout: ReturnType<typeof createTimeoutSignal>
): Response | undefined {
  if (request.signal.aborted) {
    return jsonError("Request was aborted.", CLIENT_CLOSED_REQUEST_STATUS);
  }
  if (timeout.timedOut()) {
    return jsonError(
      "Worker bridge request timed out.",
      GATEWAY_TIMEOUT_STATUS
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

/**
 * Builds the request sent to the long-running Spectrum worker. `spaceId`
 * identifies the durable conversation space, while `responseSessionId`
 * identifies this one browser request awaiting an AI SDK response stream.
 */
function createWorkerPayload(options: {
  bridgeRequestId: string;
  parsed: ParsedChatRequest;
  responseSessionId: string;
  user: SpectrumChatUser;
}): WorkerBridgeRequest {
  const { bridgeRequestId, parsed, responseSessionId, user } = options;
  return {
    messageId: parsed.requestId,
    metadata: parsed.metadata,
    requestId: bridgeRequestId,
    responseSessionId,
    spaceId: spaceIdForUser(user, parsed.conversationId),
    text: parsed.text,
    userId: user.id,
  };
}

/**
 * Converts one worker bridge event into the corresponding AI SDK UI stream
 * part, and rejects events that belong to another in-flight bridge request.
 */
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

/**
 * Pumps worker NDJSON events into the AI SDK writer until the worker stream
 * ends or the browser request is aborted.
 */
async function streamWorkerEvents(options: {
  bridgeRequestId: string;
  body: ReadableStream<Uint8Array>;
  requestSignal: AbortSignal;
  textPartId: string;
  timeout: ReturnType<typeof createTimeoutSignal>;
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
 * Wraps the worker's NDJSON response body as an AI SDK UI message stream so a
 * normal `useChat` client can consume the worker reply without knowing about
 * the bridge protocol.
 */
async function createAiSdkResponseFromWorker(options: {
  body: ReadableStream<Uint8Array>;
  bridgeRequestId: string;
  requestSignal: AbortSignal;
  timeout: ReturnType<typeof createTimeoutSignal>;
}): Promise<Response> {
  const { createUIMessageStream, createUIMessageStreamResponse } =
    await loadAiRuntime();
  const textPartId = `${options.bridgeRequestId}-text`;
  const stream = createUIMessageStream({
    execute: ({ writer }) =>
      streamWorkerEvents({
        body: options.body,
        bridgeRequestId: options.bridgeRequestId,
        requestSignal: options.requestSignal,
        textPartId,
        timeout: options.timeout,
        writer,
      }),
  });

  return createUIMessageStreamResponse({ stream });
}

/**
 * Creates a Next.js-compatible `POST` handler for browser `useChat` requests
 * and forwards each latest user turn to a separate Spectrum worker over HTTP.
 *
 * `workerUrl` points at the worker's web bridge endpoint. `apiKey`, when set,
 * is service-to-service bearer auth for that worker request. `getUser` resolves
 * the app user at the route boundary, and `timeoutMs` bounds how long this
 * route waits for the worker's streamed reply.
 *
 * The handler is intentionally request-scoped: it parses the AI SDK request,
 * sends a worker payload for the current turn, then converts the worker's
 * NDJSON bridge events back into AI SDK UI stream chunks. It never imports
 * `Spectrum()`, registers providers, or starts persistent listeners.
 *
 * Flow:
 *  1. identify the web user with getUser
 *  2. extract the latest user text from the useChat request
 *  3. forward that message to the long-running Spectrum worker
 *  4. stream the worker's response back to useChat
 */
export function createSpectrumWorkerBridge<
  User extends SpectrumChatUser = SpectrumChatUser,
>(
  options: CreateSpectrumWorkerBridgeOptions<User>
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.signal.aborted) {
      return jsonError("Request was aborted.", CLIENT_CLOSED_REQUEST_STATUS);
    }

    // 1. Resolve app user identity at the web boundary. This keeps browser
    // auth in the Next.js route and lets the bridge build user-scoped spaces.
    const user = await resolveUser(options, request);
    if (user instanceof Response) {
      return user;
    }

    // 2. Read the AI SDK useChat request body from the browser.
    const body = await parseRequestBody(request);
    if (body instanceof Response) {
      return body;
    }

    // 3. Extract the current user turn. useChat sends full history, but the
    // worker bridge forwards only the latest user text for this request.
    const parsed = parseChatRequest(body);
    if ("error" in parsed) {
      return badRequest(parsed.error);
    }

    const timeout = createTimeoutSignal(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      request.signal
    );
    const bridgeRequestId = crypto.randomUUID();
    const responseSessionId = crypto.randomUUID();
    // 4. Build the worker payload. `spaceId` is the logical web conversation;
    // `responseSessionId` is this one browser request waiting for a reply.
    const workerPayload = createWorkerPayload({
      bridgeRequestId,
      parsed,
      responseSessionId,
      user,
    });

    let workerResponse: Response;
    try {
      // 5. Forward to the long-running Spectrum worker's webBridge endpoint.
      // apiKey is service-to-service auth between this route and the worker.
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
      return jsonError("Worker bridge request failed.", workerResponse.status);
    }
    const workerBody = workerResponse.body;
    if (!workerBody) {
      timeout.cleanup();
      return internalServerError(
        "Worker bridge response did not include a body."
      );
    }

    // 6. Convert the worker's NDJSON response events back into AI SDK UI
    // stream chunks so the browser's useChat client can render the reply.
    return await createAiSdkResponseFromWorker({
      body: workerBody,
      bridgeRequestId,
      requestSignal: request.signal,
      timeout,
    });
  };
}
