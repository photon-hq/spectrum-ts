// FusorCore streaming: drives the real `fusor.v1.json` protocol
// against an in-process `ws` websocket server (runs under Node and Bun).

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { makeSlack } from "@spectrum-ts/test-support/fusor";
import { baseConfig } from "@spectrum-ts/test-support/platform";
import { NO_MESSAGE_WAIT_MS } from "@spectrum-ts/test-support/timing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { FusorCore, type RegisteredFusorHandler } from "@/fusor/core";
import type { FusorCursorStore } from "@/fusor/cursor";
import type { FusorMessagesReturn } from "@/fusor/types";
import { Spectrum } from "@/spectrum";
import { cloud } from "@/utils/cloud";

stubCloud();

const PLATFORM = "tg";
// waitFor polling: generous ceiling, tight poll.
const WAIT_TIMEOUT_MS = 5000;
const WAIT_POLL_MS = 10;
// close() must return promptly, far below the 30s max reconnect backoff.
const CLOSE_PROMPTLY_MS = 3000;

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

async function makeFusorWsServer(script: WsServerScript) {
  const inits: Frame[] = [];
  const initTimes: number[] = [];
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
        initTimes.push(Date.now());
        for (const out of script.onInit(frame, connection)) {
          ws.send(JSON.stringify(out));
        }
        const close = script.closeAfterInit?.(connection);
        if (close) {
          ws.close(close.code, close.reason);
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
    initTimes,
    replies,
    connectionCount: () => connections,
    send: (...frames: Frame[]) => {
      for (const client of wss.clients) {
        if (client.readyState !== 1) {
          continue;
        }
        for (const frame of frames) {
          client.send(JSON.stringify(frame));
        }
      }
    },
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
  seq = 1,
  platform = PLATFORM
): Frame => ({
  type: "event",
  seq,
  ...(replyExpected && { replyExpected: true }),
  event: {
    eventId,
    projectId: "proj",
    platform,
    receivedAt: "2026-06-11T00:00:00.000Z",
    prevSubjectSeq: 0,
    rawRequest: b64(httpBytes(json)),
  },
});

const emptyReply = (eventId: string) => ({
  eventId,
  errorReason: "",
  status: 200,
  headers: {},
  body: new Uint8Array(0),
});

async function waitFor(
  cond: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await sleep(WAIT_POLL_MS);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
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

  it("loads a durable cursor and checkpoints after provider processing", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame("evt-42", '{"text":"durable"}', false, 42),
      ],
    });
    cleanups.push(server.stop);

    const order: string[] = [];
    const cursorStore: FusorCursorStore = {
      load: async (projectId) => {
        order.push(`load:${projectId}`);
        return 41;
      },
      save: async (projectId, seq) => {
        order.push(`save:${projectId}:${seq}`);
      },
    };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
      cursorStore,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, {
      ...makeHandler({ payloads: [] }),
      messages: () => {
        order.push("handle");
        return [];
      },
    });
    await core.start();

    await waitFor(() => order.includes("save:proj:42"));
    expect(server.inits[0]?.startSeq).toBe(41);
    expect(order).toEqual(["load:proj", "handle", "save:proj:42"]);
  });

  it("replays an event when provider processing fails before checkpointing", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    cleanups.push(() => tokenSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame("evt-replay", '{"text":"retry"}', false, 11),
      ],
    });
    cleanups.push(server.stop);

    const saved: number[] = [];
    const cursorStore: FusorCursorStore = {
      load: () => Promise.resolve(10),
      save: (_projectId, seq) => {
        saved.push(seq);
        return Promise.resolve();
      },
    };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
      cursorStore,
    });
    cleanups.push(() => core.close());
    const processSpy = vi
      .spyOn(core, "processEvent")
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue({
        eventId: "evt-replay",
        errorReason: "",
        status: 200,
        headers: {},
        body: new Uint8Array(0),
      });
    cleanups.push(() => processSpy.mockRestore());
    await core.start();

    await waitFor(() => saved.length === 1);
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([11]);
    expect(server.inits.slice(0, 2).map((init) => init.startSeq)).toEqual([
      10, 10,
    ]);
  });

  it("retries a failed checkpoint without duplicating provider delivery", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    cleanups.push(() => tokenSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame("evt-checkpoint", '{"text":"once"}', false, 11),
      ],
    });
    cleanups.push(server.stop);

    let saveAttempts = 0;
    const cursorStore: FusorCursorStore = {
      load: () => Promise.resolve(10),
      save: () => {
        saveAttempts += 1;
        return saveAttempts === 1
          ? Promise.reject(new Error("checkpoint unavailable"))
          : Promise.resolve();
      },
    };
    const capture = { payloads: [] as unknown[] };
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
      cursorStore,
    });
    cleanups.push(() => core.close());
    core.register(PLATFORM, makeHandler(capture));
    await core.start();

    await waitFor(() => saveAttempts === 2);
    expect(capture.payloads).toEqual([{ text: "once" }]);
    expect(server.inits.slice(0, 2).map((init) => init.startSeq)).toEqual([
      10, 10,
    ]);
  });

  it("closes an overflowing event backlog and replays from the durable cursor", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    cleanups.push(() => tokenSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: (_init, connection) =>
        connection === 1
          ? [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
              eventFrame("evt-blocked", '{"text":"blocked"}', false, 11),
              eventFrame("evt-overflow", '{"text":"overflow"}', false, 12),
            ]
          : [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
            ],
    });
    cleanups.push(server.stop);

    const saved: number[] = [];
    const cursorStore: FusorCursorStore = {
      load: () => Promise.resolve(10),
      save: (_projectId, seq) => {
        saved.push(seq);
        return Promise.resolve();
      },
    };
    let releaseHandler!: () => void;
    const blockedHandler = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
      cursorStore,
      maxPendingEvents: 1,
      shutdownTimeoutMs: 25,
    });
    cleanups.push(() => core.close());
    const processSpy = vi
      .spyOn(core, "processEvent")
      .mockImplementation(async (event) => {
        await blockedHandler;
        return emptyReply(event.eventId);
      });
    cleanups.push(() => processSpy.mockRestore());
    await core.start();

    await waitFor(() => server.inits.length === 2);
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
    expect(server.inits.slice(0, 2).map((init) => init.startSeq)).toEqual([
      10, 10,
    ]);

    releaseHandler();
    await sleep(50);
    expect(saved).toEqual([]);
  });

  it("enforces the pending-byte limit before provider delivery", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    cleanups.push(() => tokenSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

    const oversized = eventFrame(
      "evt-oversized-字",
      '{"text":"too large"}',
      false,
      11
    );
    const frameBytes = Buffer.byteLength(JSON.stringify(oversized), "utf8");
    const server = await makeFusorWsServer({
      onInit: (_init, connection) =>
        connection === 1
          ? [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
              oversized,
            ]
          : [
              {
                type: "ready",
                projectId: "proj",
                heartbeatIntervalMs: 30_000,
              },
            ],
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
      maxPendingBytes: frameBytes - 1,
      shutdownTimeoutMs: 25,
    });
    cleanups.push(() => core.close());
    const processSpy = vi.spyOn(core, "processEvent");
    cleanups.push(() => processSpy.mockRestore());
    await core.start();

    await waitFor(() => server.inits.length === 2);
    expect(processSpy).not.toHaveBeenCalled();
    expect(server.inits.slice(0, 2).map((init) => init.startSeq)).toEqual([
      0, 0,
    ]);
  });

  it("releases pending-byte accounting after each durable event", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const first = eventFrame("evt-byte-1", '{"text":"first"}', false, 1);
    const second = eventFrame("evt-byte-2-字", '{"text":"second"}', false, 2);
    const maxPendingBytes = Math.max(
      Buffer.byteLength(JSON.stringify(first), "utf8"),
      Buffer.byteLength(JSON.stringify(second), "utf8")
    );
    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        first,
      ],
    });
    cleanups.push(server.stop);

    const saved: number[] = [];
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
      maxPendingBytes,
      cursorStore: {
        load: () => Promise.resolve(0),
        save: (_projectId, seq) => {
          saved.push(seq);
          return Promise.resolve();
        },
      },
    });
    cleanups.push(() => core.close());
    const processSpy = vi
      .spyOn(core, "processEvent")
      .mockImplementation((event) =>
        Promise.resolve(emptyReply(event.eventId))
      );
    cleanups.push(() => processSpy.mockRestore());
    await core.start();

    await waitFor(() => saved.includes(1));
    await sleep(WAIT_POLL_MS);
    server.send(second);
    await waitFor(() => saved.includes(2));

    expect(saved).toEqual([1, 2]);
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(server.connectionCount()).toBe(1);
  });

  it("honors drain retry hints and keeps backing off unstable sessions", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    cleanups.push(() => tokenSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: (_init, connection) => {
        if (connection === 1) {
          return [
            {
              type: "error",
              code: "server_draining",
              message: "rollout",
              fatal: true,
              retryAfterMs: 1100,
            },
          ];
        }
        return [
          { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        ];
      },
      closeAfterInit: (connection) => {
        if (connection === 1) {
          return { code: 1001, reason: "server_draining" };
        }
        if (connection === 2) {
          return { code: 1012, reason: "restart" };
        }
      },
    });
    cleanups.push(server.stop);

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
    });
    cleanups.push(() => core.close());
    await core.start();

    await waitFor(() => server.inits.length === 3, 7000);
    const firstDelay = (server.initTimes[1] ?? 0) - (server.initTimes[0] ?? 0);
    const secondDelay = (server.initTimes[2] ?? 0) - (server.initTimes[1] ?? 0);
    expect(firstDelay).toBeGreaterThanOrEqual(1000);
    // Equal jitter with Math.random() = 0 is half the exponential cap:
    // attempt two waits 1000ms. A ready-then-close loop must not reset it.
    expect(secondDelay).toBeGreaterThanOrEqual(900);
  });

  it("wires a public Spectrum cursor store into the Fusor stream", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame(
          "evt-public-store",
          '{"type":"message","text":"public"}',
          false,
          8,
          "slack"
        ),
      ],
    });
    cleanups.push(server.stop);

    const previousEndpoint = process.env.SPECTRUM_FUSOR_WS_URL;
    process.env.SPECTRUM_FUSOR_WS_URL = server.url;
    cleanups.push(() => {
      if (previousEndpoint === undefined) {
        delete process.env.SPECTRUM_FUSOR_WS_URL;
      } else {
        process.env.SPECTRUM_FUSOR_WS_URL = previousEndpoint;
      }
    });

    const saved: number[] = [];
    const cursorStore: FusorCursorStore = {
      load: () => Promise.resolve(7),
      save: (_projectId, seq) => {
        saved.push(seq);
        return Promise.resolve();
      },
    };
    const app = await Spectrum({
      ...baseConfig,
      platforms: [makeSlack().config({})],
      options: { fusorCursorStore: cursorStore },
    });
    cleanups.push(() => app.stop());
    const iterator = app.messages[Symbol.asyncIterator]();
    cleanups.push(async () => {
      await iterator.return?.();
    });

    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(result.value?.[1].content).toEqual({
      type: "text",
      text: "public",
    });
    await waitFor(() => saved.length === 1);
    expect(server.inits[0]?.startSeq).toBe(7);
    expect(saved).toEqual([8]);
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

  it("recovers when the initial token mint fails transiently", async () => {
    const tokenSpy = vi
      .spyOn(cloud, "issueFusorToken")
      .mockRejectedValueOnce(new Error("token service unavailable"))
      .mockResolvedValue({ token: "recovered", expiresIn: 900 });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    cleanups.push(() => tokenSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

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
    cleanups.push(() => core.close());
    await core.start();

    await waitFor(() => server.inits.length === 1);
    expect(tokenSpy).toHaveBeenCalledTimes(2);
    expect(server.inits[0]?.token).toBe("recovered");
  });

  it("keeps reconnect backoff referenced until close cancels it", async () => {
    const tokenSpy = vi
      .spyOn(cloud, "issueFusorToken")
      .mockRejectedValue(new Error("token service unavailable"));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    cleanups.push(() => tokenSpy.mockRestore());
    cleanups.push(() => randomSpy.mockRestore());

    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
    });
    await core.start();

    interface CoreWithReconnectTimer {
      reconnectTimer?: ReturnType<typeof setTimeout>;
    }
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    await waitFor(() => {
      reconnectTimer = (core as unknown as CoreWithReconnectTimer)
        .reconnectTimer;
      return reconnectTimer !== undefined;
    });
    expect(reconnectTimer?.hasRef()).toBe(true);

    await core.close();
    expect(
      (core as unknown as CoreWithReconnectTimer).reconnectTimer
    ).toBeUndefined();
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
  });

  it("close() bounds an uncooperative handler and never checkpoints it later", async () => {
    const tokenSpy = vi.spyOn(cloud, "issueFusorToken").mockResolvedValue({
      token: "t1",
      expiresIn: 900,
    });
    cleanups.push(() => tokenSpy.mockRestore());

    const server = await makeFusorWsServer({
      onInit: () => [
        { type: "ready", projectId: "proj", heartbeatIntervalMs: 30_000 },
        eventFrame("evt-hung", '{"text":"hung"}', true, 1),
      ],
    });
    cleanups.push(server.stop);

    const saved: number[] = [];
    let releaseHandler!: () => void;
    const hungHandler = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const core = new FusorCore({
      projectId: "proj",
      projectSecret: "secret",
      websocketEndpoint: server.url,
      shutdownTimeoutMs: 50,
      cursorStore: {
        load: () => Promise.resolve(0),
        save: (_projectId, seq) => {
          saved.push(seq);
          return Promise.resolve();
        },
      },
    });
    const processSpy = vi
      .spyOn(core, "processEvent")
      .mockImplementation(async (event) => {
        await hungHandler;
        return emptyReply(event.eventId);
      });
    cleanups.push(() => processSpy.mockRestore());
    await core.start();
    await waitFor(() => processSpy.mock.calls.length === 1);

    const closeOutcome = await Promise.race([
      core.close().then(() => "closed" as const),
      sleep(1000).then(() => "timed-out" as const),
    ]);
    expect(closeOutcome).toBe("closed");
    expect(saved).toEqual([]);
    expect(server.replies).toEqual([]);

    releaseHandler();
    await sleep(50);
    expect(saved).toEqual([]);
    expect(server.replies).toEqual([]);
  });
});
