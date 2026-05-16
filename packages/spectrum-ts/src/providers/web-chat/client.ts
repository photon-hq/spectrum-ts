import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import type { WebChatConfig, WebChatUser } from "./config";
import { createWebChatHandler } from "./handler";
import { type AsyncQueue, makeAsyncQueue } from "./queue";
import type { WebChatMessage } from "./request";
import { WebChatSession } from "./session";

const PROCESSED_DEDUPE_MAX_KEYS = 10_000;
const PROCESSED_DEDUPE_TTL_MS = 60 * 60 * 1000;

export interface WebChatProcessedStore {
  has: (key: string) => boolean;
  set: (key: string) => void;
}

export interface WebChatClient {
  close: () => Promise<void>;
  inbound: AsyncQueue<WebChatMessage>;
  pendingByRequestId: Map<string, WebChatSession>;
  processed: WebChatProcessedStore;
  server: Server;
  url: string;
}

function headersFromIncoming(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

// Standalone Node server mode is only a wrapper around the reusable handler.
// The handler works with Web Request/Response so future framework adapters can
// reuse parsing, auth, dedupe, and stream correlation without Node coupling.
function requestFromIncoming(request: IncomingMessage): Request {
  const url = `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`;
  const init: RequestInit & { duplex?: "half" } = {
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : (Readable.toWeb(request) as ReadableStream),
    duplex: "half",
    headers: headersFromIncoming(request),
    method: request.method,
  };

  return new Request(url, init);
}

function notFoundResponse(): Response {
  return Response.json({ error: "Not found." }, { status: 404 });
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

class ExpiringKeyCache implements WebChatProcessedStore {
  readonly #items = new Map<string, number>();
  readonly #now: () => number;
  readonly #options: { max: number; ttlMs: number };

  constructor(
    options = {
      max: PROCESSED_DEDUPE_MAX_KEYS,
      ttlMs: PROCESSED_DEDUPE_TTL_MS,
    },
    now = () => Date.now()
  ) {
    this.#now = now;
    this.#options = options;
  }

  has(key: string): boolean {
    const expiresAt = this.#items.get(key);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= this.#now()) {
      this.#items.delete(key);
      return false;
    }
    return true;
  }

  set(key: string): void {
    this.#items.delete(key);
    this.#items.set(key, this.#now() + this.#options.ttlMs);
    this.#prune();
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, expiresAt] of this.#items) {
      if (expiresAt <= now) {
        this.#items.delete(key);
      }
    }

    while (this.#items.size > this.#options.max) {
      const oldestKey = this.#items.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.#items.delete(oldestKey);
    }
  }
}

export async function createClient({
  config,
}: {
  config: WebChatConfig;
}): Promise<WebChatClient> {
  const inbound = makeAsyncQueue<WebChatMessage>();
  const pendingByRequestId = new Map<string, WebChatSession>();
  // Idempotency is request-scoped in memory for local/developer-hosted runtimes.
  // Bound it so long-running demo processes do not retain every message id.
  const processed = new ExpiringKeyCache();

  const resolveUser = async (request: Request): Promise<WebChatUser> => {
    if (config.auth) {
      return await config.auth(request);
    }
    const authUser = request.headers.get("x-spectrum-user-id");
    return { id: authUser ?? "anonymous" };
  };

  const handler = createWebChatHandler({
    cors: config.server.cors,
    createSession: ({ requestId, signal, timeoutMs }) => {
      const session = new WebChatSession({
        onClose: (closedSession) => {
          const current = pendingByRequestId.get(closedSession.requestId);
          if (current === closedSession) {
            pendingByRequestId.delete(closedSession.requestId);
          }
        },
        requestId,
        signal,
        timeoutMs,
      });
      // Register before enqueueing the inbound message so immediate
      // `space.send(...)` calls can find the exact request stream.
      pendingByRequestId.set(session.requestId, session);
      return session;
    },
    enqueue: (message) => inbound.push(message),
    hasProcessed: (key) => processed.has(key),
    markProcessed: (key) => processed.set(key),
    resolveUser,
    timeoutMs: config.responseTimeoutMs,
  });

  const server = createServer(async (incoming, outgoing) => {
    const response =
      requestPath(incoming) === config.server.path
        ? await handler(requestFromIncoming(incoming))
        : notFoundResponse();

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        outgoing.write(Buffer.from(value));
      }
    }
    outgoing.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { host: config.server.host, port: config.server.port },
      () => {
        server.off("error", reject);
        resolve();
      }
    );
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("webChat: failed to bind HTTP server.");
  }

  return {
    close: async () => {
      inbound.close();
      for (const session of pendingByRequestId.values()) {
        session.close();
      }
      pendingByRequestId.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    inbound,
    pendingByRequestId,
    processed,
    server,
    url: `http://${config.server.host}:${address.port}${config.server.path}`,
  };
}
