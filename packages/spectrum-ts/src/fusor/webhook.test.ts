import { describe, expect, it, spyOn } from "bun:test";
import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import z from "zod";
import type { Content } from "../content/types";
import { definePlatform } from "../platform/define";
import { Spectrum } from "../spectrum";
import type { Message } from "../types/message";
import { cloud } from "../utils/cloud";
import { FusorCore } from "./core";
import { fusor, fusorEvent } from "./index";
import type { FusorMessages } from "./types";

// Spectrum() fetches project metadata up-front when projectId/projectSecret are
// supplied. These tests use placeholder credentials, so stub the cloud call to
// avoid a real network request (and a VALIDATION_ERROR) during construction.
spyOn(cloud, "getProject").mockResolvedValue({
  id: "proj",
  name: "Test Project",
  profile: {},
});

// A minimal fusor-mode provider standing in for a real platform (Slack-ish).
// Its verify() parses the inner HTTP body to a typed payload; messages() turns
// that into provider records (or a synchronous url_verification reply).
type SlackPayload =
  | { kind: "message"; text: string }
  | { kind: "verify"; challenge: string }
  | { kind: "group"; texts: string[] }
  | { kind: "typing" };

// A typed `FusorMessages` reference (not an inline arrow). Overload resolution
// keys on this: a typed reference is non-context-sensitive, so it's checked in
// pass 1, rejects the regular overload, and selects the fusor one. An inline
// `messages: ({ payload }) => …` would be deferred and mis-commit to regular.
const slackMessages: FusorMessages<SlackPayload> = ({ payload, respond }) => {
  if (payload.kind === "verify") {
    respond({ status: 200, body: payload.challenge });
    return;
  }
  if (payload.kind === "typing") {
    // A senderless inbound signal (no `sender` field): typing carries no
    // attributable author. Core must resolve this without throwing.
    return {
      id: "t1",
      content: { type: "typing", state: "start" } as unknown as Content,
      space: { id: "s1" },
    };
  }
  if (payload.kind === "group") {
    const items = payload.texts.map((text, i) => ({
      id: `g${i}`,
      content: { type: "text", text } as Content,
      sender: { id: "u1" },
      space: { id: "s1" },
    }));
    return {
      id: "grp",
      content: { type: "group", items } as unknown as Content,
      sender: { id: "u1" },
      space: { id: "s1" },
    };
  }
  return {
    id: "m1",
    content: { type: "text", text: payload.text } as Content,
    sender: { id: "u1" },
    space: { id: "s1" },
    timestamp: new Date(0),
  };
};

const makeSlack = (opts: { verifyThrows?: boolean } = {}) =>
  definePlatform("slack", {
    config: z.object({}),
    lifecycle: {
      createClient: () =>
        Promise.resolve(
          fusor<SlackPayload>("slack", (req) => {
            if (opts.verifyThrows) {
              throw new Error("bad platform signature");
            }
            const body = JSON.parse(new TextDecoder().decode(req.rawBody)) as {
              type: string;
              text?: string;
              challenge?: string;
              texts?: string[];
            };
            if (body.type === "url_verification") {
              return { kind: "verify", challenge: body.challenge ?? "" };
            }
            if (body.type === "group") {
              return { kind: "group", texts: body.texts ?? [] };
            }
            if (body.type === "typing") {
              return { kind: "typing" };
            }
            return { kind: "message", text: body.text ?? "" };
          })
        ),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      resolve: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "space" }),
    },
    messages: slackMessages,
    send: () => Promise.resolve(undefined),
  });

// Build the protobuf POST body fusor would deliver: a RawInboundEvent whose
// rawRequest is the platform's original HTTP/1.1 wire bytes.
const encodeEvent = (
  platform: string,
  httpBody: string,
  eventId = "evt-1"
): Uint8Array => {
  const wire = `POST /${platform} HTTP/1.1\r\ncontent-type: application/json\r\n\r\n${httpBody}`;
  return RawInboundEvent.encode(
    RawInboundEvent.create({
      eventId,
      projectId: "proj",
      platform,
      rawRequest: new TextEncoder().encode(wire),
    })
  ).finish();
};

const baseConfig = {
  projectId: "proj",
  projectSecret: "secret",
} as const;

const NO_FUSOR_PROVIDER_ERROR = /requires at least one fusor provider/;

// Timing knobs for the async coordination in these tests, named so intent is
// clear and tuning is centralized.
const SETTLE_CAP_MS = 150; // upper bound on idle teardown waits (see settleSoon)
const TICK_MS = 0; // yield one event-loop turn so the lazy gRPC start can fire
const NO_MESSAGE_WAIT_MS = 50; // long enough to confirm no message arrived

// Bound teardown of an idle messages subscription: gracefully closing a fusor
// stream that never received a live event waits on the (empty) queue, which is
// irrelevant to these assertions. Cap it so the test always returns.
const settleSoon = (p: Promise<unknown> | undefined): Promise<unknown> =>
  Promise.race([
    Promise.resolve(p),
    new Promise((resolve) => {
      setTimeout(resolve, SETTLE_CAP_MS);
    }),
  ]);

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
        headers: { "content-type": "application/x-protobuf" },
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

  it("delivers a senderless inbound message (sender undefined, no throw)", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });
    const received: Message[] = [];
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const result = await spectrum.webhook(
      {
        headers: {},
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
      headers: { "content-type": "application/x-protobuf" },
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
      { headers: {}, body },
      () => undefined
    );
    const webResult = await spectrum.webhook(
      new Request("https://app.example.com/h", { method: "POST", body }),
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
      { headers: {}, body: new Uint8Array([0xff]) },
      () => undefined
    );

    expect(result.status).toBe(400);
    await spectrum.stop();
  });

  it("returns 400 when no handler is registered for the platform", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
    });

    const result = await spectrum.webhook(
      { headers: {}, body: encodeEvent("discord", "{}") },
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
        headers: {},
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
        headers: {},
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
        headers: {},
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
        headers: {},
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
      spectrum.webhook({ headers: {}, body: new Uint8Array() }, () => undefined)
    ).rejects.toThrow(NO_FUSOR_PROVIDER_ERROR);

    await spectrum.stop();
  });

  it("never opens the gRPC stream for webhook, but does for spectrum.messages", async () => {
    const startSpy = spyOn(FusorCore.prototype, "start").mockResolvedValue(
      undefined
    );
    try {
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [makeSlack().config({})],
      });

      await spectrum.webhook(
        {
          headers: {},
          body: encodeEvent(
            "slack",
            JSON.stringify({ type: "message", text: "x" })
          ),
        },
        () => undefined
      );
      expect(startSpy).not.toHaveBeenCalled();

      // First subscription to spectrum.messages triggers the lazy gRPC start.
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
    const startSpy = spyOn(FusorCore.prototype, "start").mockResolvedValue(
      undefined
    );
    try {
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [makeSlack().config({})],
      });

      const iterator = spectrum.messages[Symbol.asyncIterator]();
      const next = iterator.next();

      await spectrum.webhook(
        {
          headers: {},
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

// ---------------------------------------------------------------------------
// Fusor custom event channels (`events` schema + `fusorEvent`)
// ---------------------------------------------------------------------------

type PresencePayload =
  | { kind: "message"; text: string }
  | { kind: "presence"; user: string }
  | { kind: "viaMessagesChannel"; text: string }
  | { kind: "undeclared" };

const presenceSchema = z.object({ user: z.string(), online: z.boolean() });

// A typed `FusorMessages` reference (not inline) so overload resolution picks
// the fusor overload. Demonstrates the three routes a fusor handler can take.
const presenceMessages: FusorMessages<PresencePayload> = ({ payload }) => {
  if (payload.kind === "presence") {
    return fusorEvent("presence", { user: payload.user, online: true });
  }
  if (payload.kind === "viaMessagesChannel") {
    // `fusorEvent("messages", record)` must behave exactly like returning the
    // record bare — i.e. route to the core `spectrum.messages` stream.
    return fusorEvent("messages", {
      id: "viaev",
      content: { type: "text", text: payload.text } as Content,
      sender: { id: "u1" },
      space: { id: "s1" },
    });
  }
  if (payload.kind === "undeclared") {
    return fusorEvent("ghost", { dropped: true });
  }
  return {
    id: "pm1",
    content: { type: "text", text: payload.text } as Content,
    sender: { id: "u1" },
    space: { id: "s1" },
  };
};

const PRESENCE_PLATFORM = "pres";

const makePresence = () =>
  definePlatform(PRESENCE_PLATFORM, {
    config: z.object({}),
    lifecycle: {
      createClient: () =>
        Promise.resolve(
          fusor<PresencePayload>(PRESENCE_PLATFORM, (req) => {
            const body = JSON.parse(new TextDecoder().decode(req.rawBody)) as {
              type: string;
              text?: string;
              user?: string;
            };
            if (body.type === "presence") {
              return { kind: "presence", user: body.user ?? "" };
            }
            if (body.type === "via-messages") {
              return { kind: "viaMessagesChannel", text: body.text ?? "" };
            }
            if (body.type === "undeclared") {
              return { kind: "undeclared" };
            }
            return { kind: "message", text: body.text ?? "" };
          })
        ),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      resolve: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "space" }),
    },
    events: { presence: presenceSchema },
    messages: presenceMessages,
    send: () => Promise.resolve(undefined),
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
        headers: {},
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
        headers: {},
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
        headers: {},
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
