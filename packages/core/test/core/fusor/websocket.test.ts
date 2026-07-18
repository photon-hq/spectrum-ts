// FusorCore streaming: drives the real `fusor.v1.json` protocol
// against an in-process `ws` websocket server (runs under Node and Bun).

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { NO_MESSAGE_WAIT_MS } from "@spectrum-ts/test-support/timing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  FusorCore,
  type FusorCursorStore,
  type RegisteredFusorHandler,
} from "@/fusor/core";
import {
  type FusorMessagesReturn,
  FusorRetryableError,
  FusorTerminalError,
} from "@/fusor/types";
import { FUSOR_WS_MAX_PENDING_EVENTS } from "@/fusor/websocket";
import { cloud } from "@/utils/cloud";

const PLATFORM = "tg";
// waitFor polling: generous ceiling, tight poll.
const WAIT_TIMEOUT_MS = 5000;
const WAIT_POLL_MS = 10;
// close() must return promptly: above the 2s never-opened-socket
// failsafe, far below the 30s max reconnect backoff.
const CLOSE_PROMPTLY_MS = 3000;
const CANNOT_START_RE = /cannot start after close/;
const INVALID_CURSOR_RE = /invalid cursor/;
const JWT_NOT_INITIALIZED_RE = /jwt:not-initialized/;
const PROTOCOL_VIOLATION_RE = /protocol_violation/;
const PROJECT_MISMATCH_RE = /project_mismatch|other-project/;
const STOPPED_BEFORE_READY_RE = /stopped before websocket stream became ready/;

const httpBytes = (json: string): string =>
  `POST /${PLATFORM} HTTP/1.1\r\ncontent-type: application/json\r\n\r\n${json}`;
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

type Frame = Record<string, unknown> & { type: string };

interface WsServerScript {
  /** Close the connection right after onInit frames (code + reason). */
  closeAfterInit?: (connection: number) =>
    | {
        beforeClose?: () => void;
        code: number;
        delayMs?: number;
        reason: string;
      }
    | undefined;
  /** Called per connection with the parsed init frame; returns frames to send. */
  onInit: (init: Frame, connection: number) => Frame[];
}

async function makeFusorWsServer(script: WsServerScript) {
  const inits: Frame[] = [];
  const replies: Frame[] = [];
  let connections = 0;
  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: () => "fusor.v1.json",
  });
  wss.on("connection", (ws) => {
    connections += 1;
    const connection = connections;
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.type === "init") {
        inits.push(frame);
        for (const out of script.onInit(frame, connection)) {
          // Match retained-stream semantics: startSeq is the last completed
          // sequence, so a conforming server only sends newer positions.
          if (
            out.type === "event" &&
            typeof out.seq === "number" &&
            typeof frame.startSeq === "number" &&
            out.seq <= frame.startSeq
          ) {
            continue;
          }
          ws.send(JSON.stringify(out));
        }
        const close = script.closeAfterInit?.(connection);
        if (close) {
          const closeSocket = () => {
            close.beforeClose?.();
            ws.close(close.code, close.reason);
          };
          if (close.delayMs === undefined) {
            closeSocket();
          } else {
            setTimeout(closeSocket, close.delayMs);
          }
        }
        return;
      }
      if (frame.type === "reply") {
        replies.push(frame);
      }
    });
  });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://localhost:${port}/v1/subscribe`,
    inits,
    replies,
    connectionCount: () => connections,
    activeConnectionCount: () => wss.clients.size,
    // Fire-and-forget, matching the old Bun.serve stop(true): under Bun's ws
    // shim the close callback never fires once clients were terminated
    // server-side, so awaiting it would deadlock the afterEach cleanup.
    stop: () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
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

async function waitFor(
  cond: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await sleep(WAIT_POLL_MS);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  // Core shutdown first, then server teardown, then token mock restoration.
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("fusor websocket streaming", () => {
  it("streams events and replies only when asked", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
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
    await sleep(NO_MESSAGE_WAIT_MS);
    expect(server.replies).toHaveLength(1);
    const reply = server.replies[0];
    expect(reply?.eventId).toBe("evt-1");
    expect(reply?.status).toBe(200);
    expect((reply?.headers as Record<string, string>)["x-t"]).toBe("1");
    expect(Buffer.from(String(reply?.body), "base64").toString("utf8")).toBe(
      "ok"
    );
  });

  it("reconnects from the last completed sequence and suppresses duplicate event ids across valid gaps", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: (_init, connection) => {
        const ready = {
          type: "ready",
          projectId: "proj",
          heartbeatIntervalMs: 30_000,
        };
        if (connection === 1) {
          return [ready, eventFrame("evt-a", '{"text":"first"}', false, 10)];
        }
        if (connection === 2) {
          return [
            ready,
            // Same completed event id delivered at a newer position.
            eventFrame("evt-a", '{"text":"id replay"}', false, 11),
            // Gaps are valid for a filtered global stream and must not block it.
            eventFrame("evt-b", '{"text":"after gap"}', false, 20),
          ];
        }
        return [ready];
      },
      closeAfterInit: (connection) =>
        connection <= 2 ? { code: 1012, reason: "restart" } : undefined,
    });
    cleanups.push(server.stop);

    const capture = { payloads: [] as unknown[] };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler(capture));
    await core.start();

    await waitFor(() => server.inits.length === 3, 15_000);
    expect(server.inits.map((init) => init.startSeq)).toEqual([0, 10, 20]);

    await sleep(NO_MESSAGE_WAIT_MS);
    expect(capture.payloads).toEqual([
      { text: "first" },
      { text: "after gap" },
    ]);
  });

  it("resets full-jitter backoff after a stable ready connection", async () => {
    let clockMs = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.999);
    cleanups.push(() => dateSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const connectedAt: number[] = [];
    const server = await makeFusorWsServer({
      onInit: (_init, connection) => {
        connectedAt.push(performance.now());
        return connection === 1
          ? []
          : [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
            ];
      },
      closeAfterInit: (connection) => {
        if (connection === 1) {
          return { code: 1012, reason: "initial failure" };
        }
        if (connection === 2) {
          return {
            beforeClose: () => {
              clockMs = 30_001;
            },
            code: 1012,
            delayMs: 20,
            reason: "stable restart",
          };
        }
        return;
      },
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await core.start();

    await waitFor(() => server.inits.length === 3, 100_000);
    const secondAt = connectedAt[1];
    const thirdAt = connectedAt[2];
    expect(secondAt).toBeDefined();
    expect(thirdAt).toBeDefined();
    // random=0.999 puts full jitter near its ceiling. Resetting after the
    // 30-second logical ready period makes the next ceiling ~1s; retaining the
    // previous attempt would make it ~2s.
    expect((thirdAt ?? 0) - (secondAt ?? 0)).toBeLessThan(1600);
    expect(randomSpy).toHaveBeenCalled();
  });

  it("loads a scoped durable cursor and retries a failed save from the prior positive cursor", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: (_init, connection) =>
        connection <= 2
          ? [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
              eventFrame("evt-checkpoint", '{"text":"retry"}', false, 5),
            ]
          : [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
            ],
      closeAfterInit: (connection) =>
        connection === 2 ? { code: 1012, reason: "restart" } : undefined,
    });
    cleanups.push(server.stop);

    const loads: { projectId: string; websocketEndpoint: string }[] = [];
    const saves: {
      projectId: string;
      seq: number;
      websocketEndpoint: string;
    }[] = [];
    let failSaveOnce = true;
    const cursorStore: FusorCursorStore = {
      load: async (scope) => {
        loads.push({ ...scope });
        return 4;
      },
      save: async (scope, seq) => {
        saves.push({ ...scope, seq });
        if (failSaveOnce) {
          failSaveOnce = false;
          throw new Error("cursor store unavailable");
        }
      },
    };
    const capture = { payloads: [] as unknown[] };
    const core = new FusorCore({
      cursorStore,
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler(capture));
    await core.start();

    await waitFor(() => server.inits.length === 3, 15_000);
    // The first durable save failed, so reconnect used the loaded positive
    // cursor (4) and the real server can replay sequence 5. Only the successful
    // second save moves the third connection to 5.
    expect(server.inits.map((init) => init.startSeq)).toEqual([4, 4, 5]);
    expect(loads).toEqual([
      { projectId: "proj", websocketEndpoint: server.url },
    ]);
    expect(saves).toEqual([
      { projectId: "proj", seq: 5, websocketEndpoint: server.url },
      { projectId: "proj", seq: 5, websocketEndpoint: server.url },
    ]);

    await sleep(NO_MESSAGE_WAIT_MS);
    // Durable side effects still need provider-level idempotency when the
    // cursor store fails after handler completion.
    expect(capture.payloads).toEqual([{ text: "retry" }, { text: "retry" }]);
  });

  it("rejects an invalid durable cursor before minting a token", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "unused",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const scopes: { projectId: string; websocketEndpoint: string }[] = [];
    const core = new FusorCore({
      cursorStore: {
        load: async (scope) => {
          scopes.push({ ...scope });
          return Number.MAX_SAFE_INTEGER;
        },
        save: async () => undefined,
      },
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: "ws://cursor.invalid/v1/subscribe",
    });
    cleanups.push(() => core.close());

    await expect(core.start()).rejects.toThrow(INVALID_CURSOR_RE);
    expect(scopes).toEqual([
      {
        projectId: "proj",
        websocketEndpoint: "ws://cursor.invalid/v1/subscribe",
      },
    ]);
    expect(tokenSpy).not.toHaveBeenCalled();
  });

  it("checkpoints an explicitly terminal handler error instead of poisoning later events", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: (_init, connection) =>
        connection === 1
          ? [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
              eventFrame("evt-invalid", '{"text":"invalid"}', false, 1),
              eventFrame("evt-after", '{"text":"after"}', false, 2),
            ]
          : [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
            ],
      closeAfterInit: (connection) =>
        connection === 1 ? { code: 1012, reason: "restart" } : undefined,
    });
    cleanups.push(server.stop);

    const capture = { payloads: [] as unknown[] };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    const handler = makeHandler(capture);
    const messages = handler.messages;
    handler.messages = (context) => {
      if (context.payload.text === "invalid") {
        throw new FusorTerminalError("unsupported payload");
      }
      return messages(context);
    };
    core.register(PLATFORM, handler);
    await core.start();

    await waitFor(() => server.inits.length === 2, 10_000);
    // `0` is a live-tail sentinel, not a replay position. The invalid event is
    // completed with an error reply and checkpointed in order; the client does
    // not claim it could recover a failed first delivery by reconnecting at 0.
    expect(server.inits.map((init) => init.startSeq)).toEqual([0, 2]);
    expect(capture.payloads).toEqual([{ text: "after" }]);
  });

  it("retries an explicitly transient verifier failure before checkpointing", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: (_init, connection) =>
        connection <= 2
          ? [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
              eventFrame("evt-retry", '{"text":"retry"}', false, 1),
            ]
          : [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
            ],
      closeAfterInit: (connection) =>
        connection === 2 ? { code: 1012, reason: "restart" } : undefined,
    });
    cleanups.push(server.stop);

    let verifyAttempts = 0;
    const capture = { payloads: [] as unknown[] };
    const handler = makeHandler(capture);
    const verify = handler.verify;
    handler.verify = (request) => {
      verifyAttempts += 1;
      if (verifyAttempts === 1) {
        throw new FusorRetryableError("JWKS temporarily unavailable");
      }
      return verify(request);
    };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, handler);
    await core.start();

    await waitFor(() => server.inits.length === 3, 15_000);
    expect(server.inits.map((init) => init.startSeq)).toEqual([0, 0, 1]);
    expect(verifyAttempts).toBe(2);
    expect(capture.payloads).toEqual([{ text: "retry" }]);
  });

  it("bounds pending event work and reconnects from the last drained cursor", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: (_init, connection) => {
        const ready = {
          type: "ready",
          projectId: "proj",
          heartbeatIntervalMs: 30_000,
        };
        if (connection !== 1) {
          return [ready];
        }
        return [
          ready,
          ...Array.from(
            { length: FUSOR_WS_MAX_PENDING_EVENTS + 1 },
            (_, index) =>
              eventFrame(
                `evt-backpressure-${index + 1}`,
                '{"text":"queued"}',
                false,
                index + 1
              )
          ),
        ];
      },
    });
    cleanups.push(server.stop);

    const handlerGate = Promise.withResolvers<void>();
    let handled = 0;
    const handler = makeHandler({ payloads: [] });
    handler.messages = async () => {
      handled += 1;
      if (handled === 1) {
        await handlerGate.promise;
      }
      return [];
    };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(async () => {
      handlerGate.resolve();
      await core.close();
    });
    core.register(PLATFORM, handler);
    await core.start();

    await waitFor(() => server.activeConnectionCount() === 0, 10_000);
    handlerGate.resolve();
    await waitFor(() => server.inits.length === 2, 15_000);
    expect(server.inits.map((init) => init.startSeq)).toEqual([
      0,
      FUSOR_WS_MAX_PENDING_EVENTS,
    ]);
    expect(handled).toBe(FUSOR_WS_MAX_PENDING_EVENTS);
  });

  it("invalidates the token on a 4401 close and reconnects with a fresh one", async () => {
    let minted = 0;
    const tokenSpy = vi
      .spyOn(cloud, "issueFusorToken")
      .mockImplementation(async () => {
        minted += 1;
        return { token: `t${minted}`, expiresIn: 900 };
      });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
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

  it("does not retry the jwt:not-initialized authentication invariant", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        {
          type: "error",
          code: "unauthenticated",
          reason: "jwt:not-initialized",
          message: "JWT verifier is unavailable",
          fatal: true,
          retryable: false,
        },
      ],
      closeAfterInit: () => ({ code: 4401, reason: "unauthenticated" }),
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await expect(core.start()).rejects.toThrow(JWT_NOT_INITIALIZED_RE);

    await waitFor(() => server.inits.length === 1);
    await core.waitStopped();
    await expect(core.start()).rejects.toThrow(CANNOT_START_RE);
    // Longer than the first retry ceiling: a generic 4401 would already have
    // minted a replacement credential and opened connection two.
    await sleep(1200);
    expect(server.inits).toHaveLength(1);
    expect(tokenSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a fatal non-auth protocol error", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        {
          type: "error",
          code: "protocol_violation",
          message: "invalid init contract",
          fatal: true,
          retryable: false,
        },
      ],
      closeAfterInit: () => ({ code: 4400, reason: "protocol_violation" }),
    });
    cleanups.push(server.stop);

    const onTerminal = vi.fn();
    const core = new FusorCore({
      onTerminal,
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler({ payloads: [] }));

    await expect(core.start()).rejects.toThrow(PROTOCOL_VIOLATION_RE);
    await core.waitStopped();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(PROTOCOL_VIOLATION_RE),
      })
    );
    await sleep(1200);
    expect(server.inits).toHaveLength(1);
    expect(tokenSpy).toHaveBeenCalledTimes(1);
  });

  it("stops and surfaces a cross-project event after ready", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());
    const mismatched = eventFrame("cross-project", '{"text":"nope"}', false);
    mismatched.event = {
      ...(mismatched.event as Record<string, unknown>),
      projectId: "other-project",
    };
    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        mismatched,
      ],
    });
    cleanups.push(server.stop);
    const terminal = Promise.withResolvers<Error>();
    const core = new FusorCore({
      onTerminal: (error) => terminal.resolve(error),
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    const payloads: unknown[] = [];
    core.register(PLATFORM, makeHandler({ payloads }));

    await core.start();
    await expect(terminal.promise).resolves.toEqual(
      expect.objectContaining({
        message: expect.stringMatching(PROJECT_MISMATCH_RE),
      })
    );
    await core.waitStopped();
    expect(payloads).toEqual([]);
    expect(server.inits).toHaveLength(1);
  });

  it("close() shares completion and cancels startup while the initial token is pending", async () => {
    const tokenResult = { token: "t1", expiresIn: 900 };
    const tokenGate = Promise.withResolvers<typeof tokenResult>();
    const tokenSpy = vi
      .spyOn(cloud, "issueFusorToken")
      .mockReturnValue(tokenGate.promise);
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
      ],
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(async () => {
      tokenGate.resolve(tokenResult);
      await core.close();
    });

    const startPromise = core.start();
    await waitFor(() => tokenSpy.mock.calls.length === 1);
    const firstClose = core.close();
    const concurrentClose = core.close();
    expect(concurrentClose).toBe(firstClose);

    let closeSettled = false;
    firstClose.then(() => {
      closeSettled = true;
    });
    await sleep(NO_MESSAGE_WAIT_MS);
    expect(closeSettled).toBe(false);

    tokenGate.resolve(tokenResult);
    await startPromise;
    await firstClose;
    expect(server.connectionCount()).toBe(0);
  });

  it("close() does not open a replacement socket after token refresh resolves", async () => {
    const refreshResult = { token: "t2", expiresIn: 900 };
    const refreshGate = Promise.withResolvers<typeof refreshResult>();
    let mintCount = 0;
    const tokenSpy = vi
      .spyOn(cloud, "issueFusorToken")
      .mockImplementation(async () => {
        mintCount += 1;
        if (mintCount === 1) {
          return { token: "t1", expiresIn: 900 };
        }
        return await refreshGate.promise;
      });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        {
          type: "error",
          code: "unauthenticated",
          reason: "jwt:expired",
          message: "JWT expired",
          fatal: true,
          retryable: false,
        },
      ],
      closeAfterInit: () => ({ code: 4401, reason: "unauthenticated" }),
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(async () => {
      refreshGate.resolve(refreshResult);
      await core.close();
    });
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    const startRejection = expect(core.start()).rejects.toThrow(
      STOPPED_BEFORE_READY_RE
    );

    await waitFor(() => tokenSpy.mock.calls.length === 2, 10_000);
    const closePromise = core.close();
    let closeSettled = false;
    closePromise.then(() => {
      closeSettled = true;
    });
    await sleep(NO_MESSAGE_WAIT_MS);
    expect(closeSettled).toBe(false);

    refreshGate.resolve(refreshResult);
    await startRejection;
    await closePromise;
    await sleep(NO_MESSAGE_WAIT_MS);
    expect(server.inits).toHaveLength(1);
    expect(server.connectionCount()).toBe(1);
  });

  it("close() tears down an active websocket session promptly", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
      ],
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await core.start();
    await waitFor(() => server.inits.length === 1);

    const start = Date.now();
    await core.close();
    expect(Date.now() - start).toBeLessThan(CLOSE_PROMPTLY_MS);
    await waitFor(() => server.activeConnectionCount() === 0);
    expect(server.activeConnectionCount()).toBe(0);
  });

  it("surfaces a durable checkpoint failure that races shutdown", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame("evt-checkpoint-close", '{"text":"save"}', false, 1),
      ],
    });
    cleanups.push(server.stop);

    const saveGate = Promise.withResolvers<void>();
    let saveStarted = false;
    const core = new FusorCore({
      cursorStore: {
        load: async () => 0,
        save: async () => {
          saveStarted = true;
          await saveGate.promise;
        },
      },
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(async () => {
      saveGate.reject(new Error("cursor store unavailable"));
      await core.close().catch(() => undefined);
    });
    core.register(PLATFORM, makeHandler({ payloads: [] }));
    await core.start();
    await waitFor(() => saveStarted);

    const closePromise = core.close();
    saveGate.reject(new Error("cursor store unavailable"));
    await expect(closePromise).rejects.toThrow("cursor store unavailable");
  });

  it("close() waits for an in-flight ordered handler", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame("evt-slow", '{"text":"slow"}', false, 1),
      ],
    });
    cleanups.push(server.stop);

    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted = false;
    const capture = { payloads: [] as unknown[] };
    const handler = makeHandler(capture);
    const messages = handler.messages;
    handler.messages = async (context) => {
      handlerStarted = true;
      await handlerGate;
      return messages(context);
    };

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    core.register(PLATFORM, handler);

    let closePromise: Promise<void> | undefined;
    let closeSettled = false;
    try {
      await core.start();
      await waitFor(() => handlerStarted);

      const sharedClose = core.close();
      expect(core.close()).toBe(sharedClose);
      closePromise = sharedClose.then(() => {
        closeSettled = true;
      });
      await sleep(NO_MESSAGE_WAIT_MS);
      expect(closeSettled).toBe(false);

      releaseHandler?.();
      await closePromise;
      expect(closeSettled).toBe(true);
      expect(capture.payloads).toEqual([{ text: "slow" }]);
    } finally {
      releaseHandler?.();
      await (closePromise ?? core.close());
    }
  });
});
