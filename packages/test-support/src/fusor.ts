import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import type {
  Content,
  FusorMessages,
  FusorVerifyRequest,
  ProjectData,
} from "@spectrum-ts/core";
import { definePlatform, fusor, fusorEvent } from "@spectrum-ts/core";
import z from "zod";

// A minimal fusor-mode provider standing in for a real platform (Slack-ish).
// Its verify() parses the inner HTTP body to a typed payload; messages() turns
// that into provider records (or a synchronous url_verification reply).
export type SlackPayload =
  | { kind: "message"; text: string }
  | { kind: "verify"; challenge: string }
  | { kind: "group"; texts: string[] }
  | { kind: "typing" };

const captureVerifyRequest = (
  capture: { request?: FusorVerifyRequest } | undefined,
  request: FusorVerifyRequest
): void => {
  if (capture) {
    capture.request = request;
  }
};

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

export const makeSlack = (
  opts: {
    acceptRawBody?: boolean;
    captureRequest?: { request?: FusorVerifyRequest };
    verifyThrows?: boolean;
  } = {}
) =>
  definePlatform("slack", {
    config: z.object({}),
    lifecycle: {
      createClient: () =>
        Promise.resolve(
          fusor<SlackPayload>("slack", (req) => {
            captureVerifyRequest(opts.captureRequest, req);
            if (opts.verifyThrows) {
              throw new Error("bad platform signature");
            }
            if (opts.acceptRawBody) {
              return { kind: "typing" };
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
      create: ({ input }: { input: { users: { id: string }[] } }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "space" }),
    },
    messages: slackMessages,
    send: () => Promise.resolve(undefined),
  });

export const FUSOR_WEBHOOK_HEADERS = {
  "ce-type": "dev.spctrm.fusor.delivery",
  "content-type": "application/json",
} as const;

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export interface TestFusorWebhookEnvelope {
  body: unknown;
  bodyEncoding: "base64" | "form" | "json" | "text";
  eventId?: string;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  platform: string;
  rawBody: Uint8Array;
}

export const encodeFusorEnvelope = (
  input: TestFusorWebhookEnvelope
): Uint8Array => {
  const rawBodyBase64 = encodeBase64(input.rawBody);
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      eventId: input.eventId ?? "evt-1",
      projectId: "proj",
      platform: input.platform,
      receivedAt: "2026-07-19T00:00:00.000Z",
      sourceId: "source-1",
      prevSubjectSeq: 0,
      request: {
        method: input.method ?? "POST",
        path: input.path ?? `/${input.platform}`,
        headers: input.headers ?? { "content-type": "application/json" },
        bodyEncoding: input.bodyEncoding,
        body: input.body,
        rawBodyBase64,
      },
    })
  );
};

// Build the versioned JSON POST body Fusor delivers. `rawBodyBase64` preserves
// the provider's exact request body bytes independently from normalized JSON.
export const encodeEvent = (
  platform: string,
  httpBody: string,
  eventId = "evt-1"
): Uint8Array => {
  const rawBody = new TextEncoder().encode(httpBody);
  return encodeFusorEnvelope({
    platform,
    eventId,
    bodyEncoding: "json",
    body: JSON.parse(httpBody),
    rawBody,
  });
};

// A pre-v1 protobuf envelope, used to assert the HTTP hard cut rejects it.
export const encodeLegacyEvent = (
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

// ---------------------------------------------------------------------------
// Fusor custom event channels (`events` schema + `fusorEvent`)
// ---------------------------------------------------------------------------

export type PresencePayload =
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

export const PRESENCE_PLATFORM = "pres";

export const makePresence = () =>
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
      create: ({ input }: { input: { users: { id: string }[] } }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "space" }),
    },
    events: { presence: presenceSchema },
    messages: presenceMessages,
    send: () => Promise.resolve(undefined),
  });

// ---------------------------------------------------------------------------
// Runtime-context probe — asserts the fusor `messages` ctx now carries
// config/store/projectConfig (parity with the regular-mode handler contract).
// ---------------------------------------------------------------------------

export const CTX_PROBE_PLATFORM = "ctxprobe";

const ctxProbeConfig = z.object({ token: z.string() });

export interface CtxProbeCapture {
  config?: z.infer<typeof ctxProbeConfig>;
  projectConfig?: ProjectData | undefined;
  storeRoundTrip?: string;
}

// Records the runtime ctx its `messages` handler is invoked with, so a test can
// assert config/store/projectConfig were threaded in. A typed reference (not an
// inline arrow) so overload resolution selects the fusor overload — and typed
// `TConfig` so `config` lands as `{ token: string }`, not `unknown`.
const ctxProbeMessages =
  (
    capture: CtxProbeCapture
  ): FusorMessages<{ text: string }, z.infer<typeof ctxProbeConfig>> =>
  ({ payload, config, store, projectConfig }) => {
    capture.config = config;
    capture.projectConfig = projectConfig;
    // Prove `store` is a live Store, not a stub: a write reads back through it.
    store.set("lastText", payload.text);
    capture.storeRoundTrip = store.string("lastText");
    return {
      id: "c1",
      content: { type: "text", text: payload.text } as Content,
      sender: { id: "u1" },
      space: { id: "s1" },
    };
  };

export const makeCtxProbe = (capture: CtxProbeCapture) =>
  definePlatform(CTX_PROBE_PLATFORM, {
    config: ctxProbeConfig,
    lifecycle: {
      createClient: () =>
        Promise.resolve(
          fusor<{ text: string }>(CTX_PROBE_PLATFORM, (req) => {
            const body = JSON.parse(new TextDecoder().decode(req.rawBody)) as {
              text?: string;
            };
            return { text: body.text ?? "" };
          })
        ),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      create: ({ input }: { input: { users: { id: string }[] } }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "space" }),
    },
    messages: ctxProbeMessages(capture),
    send: () => Promise.resolve(undefined),
  });
