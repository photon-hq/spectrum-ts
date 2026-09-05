import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  CTX_PROBE_PLATFORM,
  type CtxProbeCapture,
  encodeEvent,
  encodeFusorEnvelope,
  encodeLegacyEvent,
  FUSOR_WEBHOOK_HEADERS,
  makeCtxProbe,
  makePresence,
  makeSlack,
  PRESENCE_PLATFORM,
} from "@spectrum-ts/test-support/fusor";
import { baseConfig } from "@spectrum-ts/test-support/platform";
import {
  NO_MESSAGE_WAIT_MS,
  settleSoon,
  TICK_MS,
} from "@spectrum-ts/test-support/timing";
import { describe, expect, it, vi } from "vitest";
import { FusorCore } from "@/fusor/core";
import type { FusorVerifyRequest } from "@/fusor/types";
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";

stubCloud();

const NO_FUSOR_PROVIDER_ERROR = /no fusor provider is configured/;

describe("spectrum.webhook", () => {
  it("routes by platform, resolves [space, message], and delivers to the handler", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });
    const received: [unknown, Message][] = [];
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          "slack",
          JSON.stringify({ type: "message", text: "hello" })
        ),
      },
      (space, message) => {
        received.push([space, message]);
        done();
      }
    );
    await finished;

    expect(received).toHaveLength(1);
    const first = received.at(0);
    if (!first) {
      throw new Error("expected one delivered message");
    }
    const [space, message] = first;
    expect((space as { __platform: string }).__platform).toBe("slack");
    expect(message.id).toBe("m1");
    expect(message.direction).toBe("inbound");
    expect(message.content).toEqual({ type: "text", text: "hello" });
    expect(result.status).toBe(200);

    await spectrum.stop();
  });

  it("threads config/store/projectConfig into the messages handler ctx", async () => {
    const capture: CtxProbeCapture = {};
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeCtxProbe(capture).config({ token: "tok-123" })],
    });
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          CTX_PROBE_PLATFORM,
          JSON.stringify({ text: "hello ctx" })
        ),
      },
      () => done()
    );
    await finished;

    expect(result.status).toBe(200);
    // Parsed provider config (from the platform's Zod schema), strongly typed.
    expect(capture.config).toEqual({ token: "tok-123" });
    // A live Store: the value written inside the handler reads back through it.
    expect(capture.storeRoundTrip).toBe("hello ctx");
    // Cloud project metadata (stubbed), matching the regular-mode contract.
    expect(capture.projectConfig).toEqual({
      id: "proj",
      name: "Test Project",
      profile: {},
      slug: "test-project",
    });

    await spectrum.stop();
  });

  it("delivers a senderless inbound message (sender undefined, no throw)", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });
    const received: Message[] = [];
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent("slack", JSON.stringify({ type: "typing" })),
      },
      (_space, message) => {
        received.push(message);
        done();
      }
    );
    await finished;

    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received.at(0)?.sender).toBeUndefined();
    expect(received.at(0)?.content).toEqual({ type: "typing", state: "start" });

    await spectrum.stop();
  });

  it("echoes a url_verification reply as a Web Response", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });

    const request = new Request("https://app.example.com/webhooks/fusor", {
      method: "POST",
      headers: FUSOR_WEBHOOK_HEADERS,
      body: encodeEvent(
        "slack",
        JSON.stringify({ type: "url_verification", challenge: "abc123" })
      ),
    });

    let delivered = 0;
    const response = await spectrum.webhook(request, () => {
      delivered += 1;
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
    expect(delivered).toBe(0);

    await spectrum.stop();
  });

  it("treats the Request and raw overloads equivalently", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });
    const body = encodeEvent(
      "slack",
      JSON.stringify({ type: "message", text: "hi" })
    );

    const rawResult = await spectrum.webhook(
      { headers: FUSOR_WEBHOOK_HEADERS, body },
      () => undefined
    );
    const webResult = await spectrum.webhook(
      new Request("https://app.example.com/h", {
        method: "POST",
        headers: FUSOR_WEBHOOK_HEADERS,
        body,
      }),
      () => undefined
    );

    expect(rawResult.status).toBe(200);
    expect(webResult).toBeInstanceOf(Response);
    expect(webResult.status).toBe(200);

    await spectrum.stop();
  });

  it("returns 400 for an undecodable body (poison — no retry)", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });

    const result = await spectrum.webhook(
      { headers: FUSOR_WEBHOOK_HEADERS, body: new Uint8Array([0xff]) },
      () => undefined
    );

    expect(result.status).toBe(400);
    expect(new TextDecoder().decode(result.body)).toBe(
      "malformed Fusor envelope"
    );
    await spectrum.stop();
  });

  it("passes exact body bytes and normalized request metadata to verify()", async () => {
    const capture: { request?: FusorVerifyRequest } = {};
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack({ captureRequest: capture }).config({})],
    });
    const rawBody = new TextEncoder().encode(
      '{ "type": "message", "text": "byte exact" }\n'
    );
    const body = encodeFusorEnvelope({
      platform: "slack",
      method: "PATCH",
      path: "/hooks/slack?token=a%2Bb",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Probe": "first",
        "x-probe": "second",
      },
      bodyEncoding: "json",
      body: { type: "message", text: "byte exact" },
      rawBody,
    });

    const result = await spectrum.webhook(
      { headers: FUSOR_WEBHOOK_HEADERS, body },
      () => undefined
    );

    expect(result.status).toBe(200);
    expect(capture.request?.method).toBe("PATCH");
    expect(capture.request?.path).toBe("/hooks/slack?token=a%2Bb");
    expect(capture.request?.headers["content-type"]).toBe(
      "application/json; charset=utf-8"
    );
    expect(capture.request?.headers["x-probe"]).toBe("first, second");
    expect(capture.request?.rawBody).toEqual(rawBody);

    await spectrum.stop();
  });

  it("preserves exact form, text, binary, and empty bodies", async () => {
    const capture: { request?: FusorVerifyRequest } = {};
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [
        makeSlack({ acceptRawBody: true, captureRequest: capture }).config({}),
      ],
    });
    const binary = new Uint8Array([0, 255, 128, 1]);
    const binaryBase64 = btoa(
      Array.from(binary, (byte) => String.fromCharCode(byte)).join("")
    );
    const cases = [
      {
        bodyEncoding: "form" as const,
        body: { name: "测试", tag: ["a", "b"] },
        rawBody: new TextEncoder().encode(
          "name=%E6%B5%8B%E8%AF%95&tag=a&tag=b"
        ),
      },
      {
        bodyEncoding: "text" as const,
        body: "héllo 世界",
        rawBody: new TextEncoder().encode("héllo 世界"),
      },
      {
        bodyEncoding: "base64" as const,
        body: binaryBase64,
        rawBody: binary,
      },
      {
        bodyEncoding: "text" as const,
        body: "",
        rawBody: new Uint8Array(0),
      },
    ];

    for (const testCase of cases) {
      const result = await spectrum.webhook(
        {
          headers: FUSOR_WEBHOOK_HEADERS,
          body: encodeFusorEnvelope({
            platform: "slack",
            ...testCase,
          }),
        },
        () => undefined
      );
      expect(result.status).toBe(200);
      expect(capture.request?.rawBody).toEqual(testCase.rawBody);
    }

    await spectrum.stop();
  });

  it("accepts additive v1 fields", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });
    const encoded = encodeEvent(
      "slack",
      JSON.stringify({ type: "message", text: "future" })
    );
    const envelope = JSON.parse(new TextDecoder().decode(encoded)) as {
      request: Record<string, unknown>;
      [key: string]: unknown;
    };
    envelope.futureTopLevel = { enabled: true };
    envelope.request.futureRequestField = 42;

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: new TextEncoder().encode(JSON.stringify(envelope)),
      },
      () => undefined
    );

    expect(result.status).toBe(200);
    await spectrum.stop();
  });

  it("rejects legacy protobuf envelopes", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeLegacyEvent("slack", '{"type":"message"}'),
      },
      () => undefined
    );

    expect(result.status).toBe(400);
    await spectrum.stop();
  });

  it("rejects invalid versions, encodings, body arms, and base64", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });
    const valid = JSON.parse(
      new TextDecoder().decode(encodeEvent("slack", '{"type":"message"}'))
    ) as {
      eventId: string;
      platform: string;
      prevSubjectSeq: number;
      projectId: string;
      receivedAt: string;
      schemaVersion: number;
      request: {
        body: unknown;
        bodyEncoding: string;
        method: string;
        rawBodyBase64: string;
      };
    };
    const invalidEnvelopes = [
      { ...structuredClone(valid), schemaVersion: 2 },
      { ...structuredClone(valid), eventId: "" },
      { ...structuredClone(valid), projectId: "" },
      { ...structuredClone(valid), platform: "" },
      { ...structuredClone(valid), prevSubjectSeq: -1 },
      { ...structuredClone(valid), receivedAt: "not-a-timestamp" },
      {
        ...structuredClone(valid),
        request: { ...valid.request, method: "" },
      },
      {
        ...structuredClone(valid),
        request: { ...valid.request, bodyEncoding: "yaml" },
      },
      {
        ...structuredClone(valid),
        request: { ...valid.request, bodyEncoding: "text", body: {} },
      },
      {
        ...structuredClone(valid),
        request: { ...valid.request, rawBodyBase64: "AB==" },
      },
      {
        ...structuredClone(valid),
        request: {
          ...valid.request,
          bodyEncoding: "base64",
          body: "AA==",
          rawBodyBase64: "AQ==",
        },
      },
    ];

    for (const envelope of invalidEnvelopes) {
      const result = await spectrum.webhook(
        {
          headers: FUSOR_WEBHOOK_HEADERS,
          body: new TextEncoder().encode(JSON.stringify(envelope)),
        },
        () => undefined
      );
      expect(result.status).toBe(400);
    }

    await spectrum.stop();
  });

  it("returns 400 when no handler is registered for the platform", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent("discord", "{}"),
      },
      () => undefined
    );

    expect(result.status).toBe(400);
    await spectrum.stop();
  });

  it("returns 400 when the platform verify() rejects (poison)", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack({ verifyThrows: true }).config({})],
    });

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          "slack",
          JSON.stringify({ type: "message", text: "x" })
        ),
      },
      () => undefined
    );

    expect(result.status).toBe(400);
    await spectrum.stop();
  });

  it("a handler throw does not change the response (200, runs async)", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });

    let invoked = false;
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          "slack",
          JSON.stringify({ type: "message", text: "x" })
        ),
      },
      () => {
        invoked = true;
        done();
        throw new Error("downstream db down");
      }
    );
    await finished;

    // The throw is caught + logged asynchronously; the response is unaffected.
    expect(result.status).toBe(200);
    expect(invoked).toBe(true);
    await spectrum.stop();
  });

  it("flattens group messages into one handler call per item", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
      options: { flattenGroups: true },
    });

    const received: Message[] = [];
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();
    await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          "slack",
          JSON.stringify({ type: "group", texts: ["a", "b"] })
        ),
      },
      (_space, message) => {
        received.push(message);
        if (received.length === 2) {
          done();
        }
      }
    );
    await finished;

    expect(received.map((m) => m.content)).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);

    await spectrum.stop();
  });

  it("isolates a handler throw per message — the rest of the batch still delivers", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
      options: { flattenGroups: true },
    });

    const received: Message[] = [];
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();
    await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          "slack",
          JSON.stringify({ type: "group", texts: ["a", "b"] })
        ),
      },
      (_space, message) => {
        received.push(message);
        // The first item throws; the second must still be delivered.
        if (received.length === 1) {
          throw new Error("first item failed");
        }
        done();
      }
    );
    await finished;

    expect(received.map((m) => m.content)).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);

    await spectrum.stop();
  });

  it("throws when no fusor provider is configured", async () => {
    const spectrum = await Spectrum({ providers: [] });

    await expect(
      spectrum.webhook(
        {
          headers: FUSOR_WEBHOOK_HEADERS,
          body: encodeEvent("slack", '{"type":"message"}'),
        },
        () => undefined
      )
    ).rejects.toThrow(NO_FUSOR_PROVIDER_ERROR);

    await spectrum.stop();
  });

  it("never opens the Fusor stream for webhook, but does for spectrum.messages", async () => {
    const startSpy = vi
      .spyOn(FusorCore.prototype, "start")
      .mockResolvedValue(undefined);
    try {
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [makeSlack().config({})],
      });

      await spectrum.webhook(
        {
          headers: FUSOR_WEBHOOK_HEADERS,
          body: encodeEvent(
            "slack",
            JSON.stringify({ type: "message", text: "x" })
          ),
        },
        () => undefined
      );
      expect(startSpy).not.toHaveBeenCalled();

      // First subscription to spectrum.messages triggers the lazy stream start.
      const iterator = spectrum.messages[Symbol.asyncIterator]();
      const pending = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      expect(startSpy).toHaveBeenCalledTimes(1);

      await settleSoon(iterator.return?.());
      await settleSoon(pending.catch(() => undefined));
      await settleSoon(spectrum.stop());
    } finally {
      startSpy.mockRestore();
    }
  });

  it("does not feed spectrum.messages (webhook is request-scoped)", async () => {
    const startSpy = vi
      .spyOn(FusorCore.prototype, "start")
      .mockResolvedValue(undefined);
    try {
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [makeSlack().config({})],
      });

      const iterator = spectrum.messages[Symbol.asyncIterator]();
      const next = iterator.next();

      await spectrum.webhook(
        {
          headers: FUSOR_WEBHOOK_HEADERS,
          body: encodeEvent(
            "slack",
            JSON.stringify({ type: "message", text: "x" })
          ),
        },
        () => undefined
      );

      const sentinel = Symbol("no-message");
      const winner = await Promise.race([
        next.then(() => "got-message"),
        new Promise((resolve) =>
          setTimeout(() => resolve(sentinel), NO_MESSAGE_WAIT_MS)
        ),
      ]);
      expect(winner).toBe(sentinel);

      await settleSoon(iterator.return?.());
      await settleSoon(next.catch(() => undefined));
      await settleSoon(spectrum.stop());
    } finally {
      startSpy.mockRestore();
    }
  });
});

describe("fusor events", () => {
  it("routes fusorEvent(channel) to spectrum.<channel>, not the message handler", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makePresence().config({})],
    });
    // Attach to the presence stream before firing so the broadcaster is wired.
    const presence = (
      spectrum as unknown as { presence: AsyncIterable<unknown> }
    ).presence[Symbol.asyncIterator]();
    const firstPresence = presence.next();

    let handlerCalls = 0;
    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          PRESENCE_PLATFORM,
          JSON.stringify({ type: "presence", user: "alice" })
        ),
      },
      () => {
        handlerCalls += 1;
      }
    );
    expect(result.status).toBe(200);

    const event = await firstPresence;
    expect(event.done).toBe(false);
    expect(event.value).toEqual({
      user: "alice",
      online: true,
      platform: PRESENCE_PLATFORM,
    });
    // The event went to the channel, NOT the (messages-only) webhook handler.
    expect(handlerCalls).toBe(0);

    await presence.return?.();
    await spectrum.stop();
  });

  it("treats fusorEvent('messages', record) like a bare record", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makePresence().config({})],
    });
    const received: Message[] = [];
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          PRESENCE_PLATFORM,
          JSON.stringify({ type: "via-messages", text: "hi" })
        ),
      },
      (_space, message) => {
        received.push(message);
        done();
      }
    );
    await finished;

    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received.at(0)?.content).toEqual({ type: "text", text: "hi" });

    await spectrum.stop();
  });

  it("drops an undeclared event channel without delivering to the handler", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makePresence().config({})],
    });
    let handlerCalls = 0;
    const result = await spectrum.webhook(
      {
        headers: FUSOR_WEBHOOK_HEADERS,
        body: encodeEvent(
          PRESENCE_PLATFORM,
          JSON.stringify({ type: "undeclared" })
        ),
      },
      () => {
        handlerCalls += 1;
      }
    );
    // Graceful: a 200 reply and nothing delivered to the message handler.
    expect(result.status).toBe(200);
    await new Promise((resolve) => {
      setTimeout(resolve, NO_MESSAGE_WAIT_MS);
    });
    expect(handlerCalls).toBe(0);

    await spectrum.stop();
  });
});
