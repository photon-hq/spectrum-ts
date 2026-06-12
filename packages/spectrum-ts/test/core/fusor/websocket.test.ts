// FusorCore websocket fallback: drives the real `fusor.v1.json` protocol
// against an in-process Bun.serve websocket server. The gRPC endpoint
// points at a dead port so every cycle exercises the
// grpc-first → websocket-fallback policy.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { serve, sleep } from "bun";
import { FusorCore, type RegisteredFusorHandler } from "@/fusor/core";
import type { FusorMessagesReturn } from "@/fusor/types";
import { cloud } from "@/utils/cloud";

const DEAD_GRPC_ENDPOINT = "127.0.0.1:1";
const PLATFORM = "tg";
const INVALID_TRANSPORT_RE = /invalid transport/;

const httpBytes = (json: string): string =>
  `POST /${PLATFORM} HTTP/1.1\r\ncontent-type: application/json\r\n\r\n${json}`;
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

type Frame = Record<string, unknown> & { type: string };

interface WsServerScript {
  /** Close the connection right after onInit frames (code + reason). */
  closeAfterInit?: (
    connection: number
  ) => { code: number; reason: string } | undefined;
  /** Called per connection with the parsed init frame; returns frames to send. */
  onInit: (init: Frame, connection: number) => Frame[];
}

function makeFusorWsServer(script: WsServerScript) {
  const inits: Frame[] = [];
  const replies: Frame[] = [];
  let connections = 0;
  const server = serve<{ connection: number }, never>({
    port: 0,
    fetch(req, srv) {
      connections += 1;
      const upgraded = srv.upgrade(req, {
        headers: { "Sec-WebSocket-Protocol": "fusor.v1.json" },
        data: { connection: connections },
      });
      if (upgraded) {
        return undefined as unknown as Response;
      }
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as Frame;
        if (frame.type === "init") {
          inits.push(frame);
          for (const out of script.onInit(frame, ws.data.connection)) {
            ws.send(JSON.stringify(out));
          }
          const close = script.closeAfterInit?.(ws.data.connection);
          if (close) {
            ws.close(close.code, close.reason);
          }
          return;
        }
        if (frame.type === "reply") {
          replies.push(frame);
        }
      },
    },
  });
  return {
    url: `ws://localhost:${server.port}/v1/subscribe`,
    inits,
    replies,
    connectionCount: () => connections,
    stop: () => {
      server.stop(true).catch(() => {
        // stop(true) can hang/reject with in-process clients; ignored.
      });
    },
  };
}

function makeHandler(capture: {
  payloads: unknown[];
}): RegisteredFusorHandler<{ text: string }> {
  return {
    verify: (req) =>
      JSON.parse(new TextDecoder().decode(req.rawBody)) as { text: string },
    messages: ({ payload, respond }): FusorMessagesReturn => {
      capture.payloads.push(payload);
      respond({ status: 200, headers: { "X-T": "1" }, body: "ok" });
      // No derived records — the reply via respond() is the whole point.
      return [];
    },
    pushMessage: () => undefined,
    pushEvent: () => undefined,
  };
}

const eventFrame = (
  eventId: string,
  json: string,
  replyExpected: boolean,
  seq = 1
): Frame => ({
  type: "event",
  seq,
  ...(replyExpected && { replyExpected: true }),
  event: {
    eventId,
    projectId: "proj",
    platform: PLATFORM,
    receivedAt: "2026-06-11T00:00:00.000Z",
    prevSubjectSeq: 0,
    rawRequest: b64(httpBytes(json)),
  },
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await sleep(10);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe("fusor websocket fallback", () => {
  it("falls back to websocket when grpc is unreachable, streams events, and replies only when asked", async () => {
    const tokenSpy = spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame("evt-1", '{"text":"hello"}', true, 1),
        eventFrame("evt-2", '{"text":"quiet"}', false, 2),
      ],
    });
    cleanups.push(server.stop);

    const capture = { payloads: [] as unknown[] };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      endpoint: DEAD_GRPC_ENDPOINT,
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler(capture));
    await core.start();

    await waitFor(() => server.replies.length === 1);

    // init carried the minted token and a live-tail cursor.
    expect(server.inits[0]?.token).toBe("t1");
    expect(server.inits[0]?.startSeq).toBe(0);

    // Both events reached the handler, in order.
    await waitFor(() => capture.payloads.length === 2);
    expect(capture.payloads).toEqual([{ text: "hello" }, { text: "quiet" }]);

    // Exactly one reply — evt-2 had no replyExpected, so replying would
    // earn a reply_unknown_event notice from the real server.
    await sleep(50);
    expect(server.replies).toHaveLength(1);
    const reply = server.replies[0];
    expect(reply?.eventId).toBe("evt-1");
    expect(reply?.status).toBe(200);
    expect((reply?.headers as Record<string, string>)["x-t"]).toBe("1");
    expect(Buffer.from(String(reply?.body), "base64").toString("utf8")).toBe(
      "ok"
    );
  });

  it("invalidates the token on a 4401 close and reconnects with a fresh one", async () => {
    let minted = 0;
    const tokenSpy = spyOn(cloud, "issueFusorToken").mockImplementation(
      async () => {
        minted += 1;
        return { token: `t${minted}`, expiresIn: 900 };
      }
    );
    cleanups.push(() => tokenSpy.mockRestore());

    const server = makeFusorWsServer({
      onInit: (_init, connection) =>
        connection === 1
          ? [
              {
                type: "error",
                code: "unauthenticated",
                reason: "jwt:expired",
                message: "JWT verification failed",
                fatal: true,
                retryable: false,
              },
            ]
          : [{ type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 }],
      closeAfterInit: (connection) =>
        connection === 1
          ? { code: 4401, reason: "unauthenticated" }
          : undefined,
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      endpoint: DEAD_GRPC_ENDPOINT,
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await core.start();

    // First connection is rejected with 4401 → token invalidated → the
    // reconnect cycle (1s backoff) mints a fresh token for connection 2.
    await waitFor(() => server.inits.length === 2, 10_000);
    expect(server.inits[0]?.token).toBe("t1");
    expect(server.inits[1]?.token).toBe("t2");
  });

  it("transport: websocket never touches gRPC — even an unparseable grpc endpoint is ignored", async () => {
    const tokenSpy = spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
      ],
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      // Would crash channel creation if the grpc path were ever taken.
      endpoint: "not a valid grpc target at all",
      websocketEndpoint: server.url,
      transport: "websocket",
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await core.start();

    await waitFor(() => server.inits.length === 1);
    expect(server.inits[0]?.token).toBe("t1");
  });

  it("transport: grpc never falls back to websocket", async () => {
    const tokenSpy = spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = makeFusorWsServer({ onInit: () => [] });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      endpoint: DEAD_GRPC_ENDPOINT,
      websocketEndpoint: server.url,
      transport: "grpc",
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await core.start();

    // Long enough for several grpc-fail/backoff cycles; the ws server
    // must stay untouched.
    await sleep(1500);
    expect(server.connectionCount()).toBe(0);
  });

  it("rejects an invalid transport value", () => {
    expect(
      () =>
        new FusorCore({
          projectId: "proj",
          projectSecret: "secret",
          transport: "carrier-pigeon" as never,
        })
    ).toThrow(INVALID_TRANSPORT_RE);
  });

  it("close() tears down an active websocket session promptly", async () => {
    const tokenSpy = spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
      ],
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      endpoint: DEAD_GRPC_ENDPOINT,
      websocketEndpoint: server.url,
    });
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await core.start();
    await waitFor(() => server.inits.length === 1);

    const start = Date.now();
    await core.close();
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
