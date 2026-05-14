import { createServer, type IncomingMessage, type Server } from "node:http";
import { asText } from "../../content/text";
import type { ProviderMessage } from "../../platform/types";
import { type AsyncQueue, makeAsyncQueue } from "../vercel-ai-sdk-ui/queue";
import {
  bridgeRequestSchema,
  type WebBridgeConfig,
  type WebBridgeRequest,
} from "./config";
import { PendingBridgeSession, writeNdjsonHeaders } from "./session";

const UNAUTHORIZED_STATUS = 401;
const NOT_FOUND_STATUS = 404;
const METHOD_NOT_ALLOWED_STATUS = 405;
const BAD_REQUEST_STATUS = 400;
const MAX_BODY_BYTES = 1_000_000;

export type WebBridgeMessage = ProviderMessage<
  { id: string },
  {
    id: string;
    messageId: string;
    requestId: string;
    responseSessionId: string;
    userId: string;
  },
  { metadata?: unknown }
>;

export interface WebBridgeClient {
  close: () => Promise<void>;
  inbound: AsyncQueue<WebBridgeMessage>;
  pendingByResponseSessionId: Map<string, PendingBridgeSession>;
  server: Server;
  url: string;
}

function respondJson(
  response: import("node:http").ServerResponse,
  status: number,
  error: string
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return;
  }
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return;
  }
  return token;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function toProviderMessage(input: WebBridgeRequest): WebBridgeMessage {
  return {
    id: input.messageId,
    content: asText(input.text),
    metadata: input.metadata,
    sender: { id: input.userId },
    space: {
      id: input.spaceId,
      messageId: input.messageId,
      requestId: input.requestId,
      responseSessionId: input.responseSessionId,
      userId: input.userId,
    },
    timestamp: new Date(),
  };
}

/**
 * Starts the local HTTP bridge used by a long-running Spectrum worker.
 *
 * This function is called only from the provider lifecycle so importing
 * `webBridge` stays side-effect free. That is important for package users and
 * for Next.js routes that import types/helpers without starting a worker.
 */
export async function createClient({
  config,
}: {
  config: WebBridgeConfig;
}): Promise<WebBridgeClient> {
  const inbound = makeAsyncQueue<WebBridgeMessage>();
  const pendingByResponseSessionId = new Map<string, PendingBridgeSession>();

  const removeSession = (session: PendingBridgeSession) => {
    const current = pendingByResponseSessionId.get(session.responseSessionId);
    if (current === session) {
      pendingByResponseSessionId.delete(session.responseSessionId);
    }
  };

  const server = createServer(async (request, response) => {
    if (request.url !== config.server.endpoint) {
      respondJson(response, NOT_FOUND_STATUS, "Not found.");
      return;
    }
    if (request.method !== "POST") {
      respondJson(response, METHOD_NOT_ALLOWED_STATUS, "Method not allowed.");
      return;
    }
    if (config.server.apiKey && bearerToken(request) !== config.server.apiKey) {
      respondJson(response, UNAUTHORIZED_STATUS, "Unauthorized.");
      return;
    }

    let parsed: WebBridgeRequest;
    try {
      parsed = bridgeRequestSchema.parse(await readJsonBody(request));
    } catch {
      respondJson(response, BAD_REQUEST_STATUS, "Invalid bridge request.");
      return;
    }

    if (pendingByResponseSessionId.has(parsed.responseSessionId)) {
      respondJson(response, BAD_REQUEST_STATUS, "Duplicate responseSessionId.");
      return;
    }

    writeNdjsonHeaders(response);
    const session = new PendingBridgeSession({
      onClose: removeSession,
      requestId: parsed.requestId,
      response,
      responseSessionId: parsed.responseSessionId,
      timeoutMs: config.responseTimeoutMs,
    });
    pendingByResponseSessionId.set(parsed.responseSessionId, session);

    // Queue after session registration so a synchronous app.messages handler
    // can immediately call space.send(...) without racing the HTTP setup.
    inbound.push(toProviderMessage(parsed));
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
    throw new Error("web-bridge: failed to bind HTTP server.");
  }

  return {
    inbound,
    pendingByResponseSessionId,
    server,
    url: `http://${config.server.host}:${address.port}${config.server.endpoint}`,
    close: async () => {
      inbound.close();
      for (const session of pendingByResponseSessionId.values()) {
        session.close();
      }
      pendingByResponseSessionId.clear();
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
  };
}
