# Building a Fusor-backed Spectrum adapter

Spectrum calls a messaging integration a **provider**. This guide uses
**adapter** and **provider** interchangeably and shows how to publish one as an
independent package.

The [Telegram provider](./packages/telegram/src/index.ts) is the primary
reference implementation. It is Fusor-backed, with a deliberate split:

- **Inbound:** Telegram posts webhooks to Fusor. Spectrum verifies and parses
  the relayed raw request through the Telegram provider.
- **Outbound:** The provider calls the Telegram Bot API directly. Fusor is not
  in the outbound path.

The same design works for any webhook-driven platform. This guide covers the
provider contract, not adding a first-party package to this monorepo or wiring
Spectrum's metapackage, manifest, release scripts, and public navigation.

## How the pieces fit

```text
External platform
  -> https://<project-slug>.<fusor-ingress>/<platform>
  -> Fusor preserves the original method, path, headers, and body
  -> fusor(<platform>, verify) authenticates and parses the request
  -> messages(ctx) maps the payload to Spectrum records
  -> app.messages or app.webhook() delivers [space, message]

Application code
  -> space.send(...) / message.reply(...) / message.react(...)
  -> provider send(ctx)
  -> external platform API
```

Fusor ingress is platform-agnostic. Normally, adding an adapter requires no
Fusor service change: configure the external platform to use a new path segment
and register a Spectrum provider with the same platform ID.

Spectrum supports two Fusor consumption modes with the same provider pipeline:

- Iterating `app.messages` lazily opens the project-scoped Fusor WebSocket
  stream. This mode requires `projectId` and `projectSecret`.
- Calling `app.webhook(request, handler)` processes one supported Fusor
  envelope synchronously and does not open the stream.

If a deployment receives Fusor's schema-v1 JSON relay, normalize and verify
that outer delivery at the HTTP boundary before passing it to `app.webhook()`.
Keep that transport concern separate from the provider's `verify`, which must
authenticate the **inner request from the external platform**. The standalone
[LinQ adapter](https://github.com/photon-hq/linq/blob/main/src/webhook.ts) is a
current example of such a boundary normalizer.

## 1. Choose one canonical platform ID

The same ID must be used for all of the following:

1. the first argument to `definePlatform`,
2. the routing key passed to `fusor`, and
3. the first path segment in the Fusor ingress URL.

Define it once and reuse it:

```ts
export const ACME_PLATFORM = "acme" as const;
```

Spectrum platform IDs must match
`/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/`: start with a lowercase letter and use
lowercase snake case. Do not use display names, uppercase letters, spaces, or
hyphens. A mismatch does not degrade gracefully; the delivery reaches Spectrum
with no matching handler.

## 2. Scaffold the external package

A practical starting layout is:

```text
src/
  index.ts             # definePlatform(...) and public exports
  config.ts            # Zod config and the platform ID constant
  types.ts             # validated inbound payload types
  verify.ts            # raw request authentication and parsing
  client.ts            # wrapper around the platform's outbound SDK
  space.ts             # user and space resolution
  webhook.ts           # optional outer relay normalization/hosting helper
  inbound/
    messages.ts        # payload -> ProviderMessageRecord
  outbound/
    send.ts            # Spectrum Content -> platform API
test/
  config.test.ts
  verify.test.ts
  inbound.test.ts
  outbound.test.ts
  webhook.test.ts      # when the package owns a hosting helper
```

An external adapter should use the public `spectrum-ts` entries. Declare
Spectrum, TypeScript, and Zod as peers so the application owns their versions;
put the platform SDK in `dependencies`:

```jsonc
{
  "name": "@your-scope/spectrum-acme",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "spectrum-ts": "^12.7.0",
    "typescript": "^5 || ^6.0.0",
    "zod": "^4"
  },
  "devDependencies": {
    "spectrum-ts": "^12.7.0",
    "typescript": "^5.9.0",
    "zod": "^4.2.0"
  },
  "dependencies": {
    "@acme/sdk": "^1.0.0"
  }
}
```

Set the Spectrum peer lower bound to the earliest version against which the
adapter is tested. The versions above match the API used by this guide.

## 3. Define and validate configuration

Use a Zod object for user-supplied credentials and behavior:

```ts
// src/config.ts
import z from "zod";

export const ACME_PLATFORM = "acme" as const;

export const configSchema = z.object({
  apiKey: z.string().min(1),
  webhookSigningSecret: z.string().min(1),
  baseUrl: z.url().default("https://api.acme.example"),
  replayToleranceSeconds: z.number().int().positive().default(300),
});

export type AcmeConfig = z.infer<typeof configSchema>;
```

`definePlatform` automatically adds environment fallbacks for string-leaf
fields. For this example, omitted values can come from:

- `SPECTRUM_ACME_API_KEY`
- `SPECTRUM_ACME_WEBHOOK_SIGNING_SECRET`
- `SPECTRUM_ACME_BASE_URL`

Explicit configuration wins over the environment, and the Zod field still
validates the resolved value. Numbers, booleans, arrays, and nested objects do
not receive automatic string environment fallbacks; parse those explicitly if
the adapter needs them.

Treat webhook verification as required in production. Only make a signing
secret optional when the platform genuinely offers no authentication mechanism
and document the resulting boundary clearly.

## 4. Model the verified payload

Parse untrusted JSON as `unknown`, then validate the fields used by the mapper:

```ts
// src/types.ts
import z from "zod";

export const acmePayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.created"),
    eventId: z.string().min(1),
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    senderId: z.string().min(1),
    text: z.string().min(1),
    sentAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("endpoint.challenge"),
    challenge: z.string(),
  }),
]);

export type AcmePayload = z.infer<typeof acmePayloadSchema>;
```

Prefer the platform's official generated types when they describe the wire
payload accurately, as Telegram does with `@photon-ai/telegram-ts`. Still
perform enough runtime validation to reject malformed input before the mapper
depends on it.

## 5. Verify the original request and parse it

`fusor()` receives a `FusorVerifyRequest`:

```ts
interface FusorVerifyRequest {
  headers: Record<string, string>; // names are lowercase
  method: string;
  path: string;                    // includes the query string
  rawBody: Uint8Array;             // exact provider body bytes
}
```

Authenticate the exact `rawBody`; never parse and reserialize JSON before
checking a signature. Follow the external platform's precise signing algorithm.
This HMAC example signs `<timestamp>.<raw body>` and enforces a replay window:

```ts
// src/verify.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FusorVerify, FusorVerifyRequest } from "spectrum-ts";
import type { AcmeConfig } from "./config";
import { acmePayloadSchema, type AcmePayload } from "./types";

const SIGNATURE_HEADER = "x-acme-signature";
const TIMESTAMP_HEADER = "x-acme-timestamp";
const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const MILLISECONDS_PER_SECOND = 1000;

const safeEqualHex = (expected: string, provided: string): boolean => {
  if (!HEX_SHA256.test(provided)) {
    return false;
  }
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(provided, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

const verifySignature = (
  request: FusorVerifyRequest,
  config: AcmeConfig
): void => {
  const timestamp = request.headers[TIMESTAMP_HEADER];
  const signature = request.headers[SIGNATURE_HEADER];
  if (!(timestamp && signature)) {
    throw new Error("Acme webhook is missing signature headers");
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Date.now() / MILLISECONDS_PER_SECOND;
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > config.replayToleranceSeconds
  ) {
    throw new Error("Acme webhook timestamp is outside the replay window");
  }

  const expected = createHmac("sha256", config.webhookSigningSecret)
    .update(timestamp)
    .update(".")
    .update(request.rawBody)
    .digest("hex");
  if (!safeEqualHex(expected, signature)) {
    throw new Error("Acme webhook signature mismatch");
  }
};

export const makeVerify =
  (config: AcmeConfig): FusorVerify<AcmePayload> =>
  (request): AcmePayload => {
    verifySignature(request, config);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(request.rawBody)) as unknown;
    } catch {
      throw new Error("Acme webhook body is not valid JSON");
    }
    return acmePayloadSchema.parse(parsed);
  };
```

Keep `verify` deterministic and request-local. Do not call the outbound API,
download media, mutate application state, or start a second delivery loop from
it. Throw only for requests that are unauthentic or malformed. A throw rejects
the Fusor event as poison; transient application work belongs after delivery.

## 6. Map verified events to Spectrum records

A Fusor provider's `messages` function runs once per verified webhook payload.
It returns one record, an array of records, a custom `fusorEvent`, or
`undefined` for an event the application should not see.

Define this as an explicitly typed function and pass the reference to
`definePlatform`. This is important: `definePlatform` also supports regular,
long-lived clients, and an untyped inline `messages` arrow can select the wrong
overload during TypeScript inference.

```ts
// src/inbound/messages.ts
import type { FusorMessages } from "spectrum-ts";
import { asText, type ProviderMessageRecord } from "spectrum-ts/authoring";
import type { AcmeConfig } from "../config";
import type { AcmePayload } from "../types";

export const handleMessages: FusorMessages<AcmePayload, AcmeConfig> = ({
  payload,
  respond,
}): ProviderMessageRecord | undefined => {
  switch (payload.type) {
    case "endpoint.challenge":
      respond({ status: 200, body: payload.challenge });
      return;
    case "message.created":
      return {
        id: payload.messageId,
        content: asText(payload.text),
        sender: { id: payload.senderId },
        space: { id: payload.chatId },
        timestamp: new Date(payload.sentAt),
      };
  }
};
```

A `ProviderMessageRecord` contains the platform-native information Spectrum
needs to build a full `Message`:

```ts
type ProviderMessageRecord = {
  id: string;
  content: Content;
  direction?: "inbound" | "outbound";
  sender?: { id: string } & Record<string, unknown>;
  space: { id: string } & Record<string, unknown>;
  timestamp?: Date;
} & Record<string, unknown>;
```

Mapping guidelines:

- Preserve the platform's stable message or event ID for deduplication.
- Omit `sender` for legitimate senderless signals.
- Return `undefined` for unsupported event types and echoes of your own sends.
- Return an array when one platform event represents multiple independent
  messages. Use `asGroup` when the parts form one logical bundle.
- Make media `read()` functions lazy so downloading bytes does not delay the
  webhook acknowledgement.
- Use `respond()` only for synchronous protocol replies such as endpoint
  challenges. It shapes the HTTP reply; it does not emit a Spectrum message.
- Declare typed custom event channels with `events` and return `fusorEvent()`
  when a platform signal should not enter the message stream.

## 7. Resolve users and spaces

Every provider resolves user IDs and knows how to address or create a space:

```ts
// src/space.ts
export interface AcmeSpace {
  id: string;
}

export const resolveUser = ({
  input,
}: {
  input: { userID: string };
}): Promise<{ id: string }> => Promise.resolve({ id: input.userID });

export const createSpace = ({
  input,
}: {
  input: { users: { id: string }[] };
}): Promise<AcmeSpace> => {
  const [recipient, ...additionalRecipients] = input.users;
  if (!recipient) {
    throw new Error("Acme space creation requires a recipient");
  }
  if (additionalRecipients.length > 0) {
    throw new Error("Acme does not support creating group conversations");
  }
  return Promise.resolve({ id: recipient.id });
};
```

Use `space.create`, not the retired `space.resolve` API. Add `space.get` when a
known platform space ID must be hydrated with additional required fields; if
`{ id }` already satisfies the space schema, Spectrum supplies the default.

## 8. Dispatch outbound content

The `send` function receives every Spectrum content type. Call the external
platform API directly and return a record for operations that produce a
message:

```ts
// src/outbound/send.ts
import { type Content, UnsupportedError } from "spectrum-ts";
import type { ProviderMessageRecord } from "spectrum-ts/authoring";
import { acmeClient } from "../client";
import { ACME_PLATFORM, type AcmeConfig } from "../config";
import type { AcmeSpace } from "../space";

interface SendArgs {
  config: AcmeConfig;
  content: Content;
  space: AcmeSpace;
}

export const send = async ({
  config,
  content,
  space,
}: SendArgs): Promise<ProviderMessageRecord | undefined> => {
  const client = acmeClient(config);

  switch (content.type) {
    case "text": {
      const sent = await client.sendMessage(space.id, content.text);
      return {
        id: sent.id,
        content,
        space: { id: space.id },
        timestamp: new Date(sent.sentAt),
      };
    }
    case "reaction": {
      await client.addReaction(
        space.id,
        content.target.id,
        content.emoji
      );
      return {
        id: `reaction:${content.target.id}:self:${content.emoji}`,
        content,
        space: { id: space.id },
        timestamp: new Date(),
      };
    }
    case "typing":
      await client.setTyping(space.id, content.state === "start");
      return;
    default:
      throw UnsupportedError.content(content.type, ACME_PLATFORM);
  }
};
```

Return semantics matter:

- Text, attachments, replies, reactions, and other message-producing actions
  return a `ProviderMessageRecord`.
- If the platform acknowledges a reaction without assigning it an ID, create a
  deterministic synthetic ID so Spectrum can return a usable message handle.
- Typing, edits, renames, avatars, and other control operations may return
  `undefined` when the platform returns no message identity.
- Throw `UnsupportedError.content(type, platform, detail?)` for content the
  platform cannot represent. Do not silently claim success.

In Fusor mode, the `client` value in Spectrum's internal send context is the
branded `FusorClient`, not the external platform SDK. Telegram constructs its
cheap Bot API client inside each operation. If construction is expensive, build
the outbound client in `lifecycle.createClient`, store it in the provided
per-platform `store`, and retrieve it in `send` and other actions.

## 9. Wire the provider together

Use `definePlatform`; `defineFusorPlatform` was retired. Annotate the lifecycle
return as `FusorClient<Payload>` and use the typed `messages` reference so
overload selection is unambiguous:

```ts
// src/index.ts
import {
  definePlatform,
  type FusorClient,
  fusor,
} from "spectrum-ts";
import { ACME_PLATFORM, configSchema } from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { createSpace, resolveUser } from "./space";
import type { AcmePayload } from "./types";
import { makeVerify } from "./verify";

export type { AcmeConfig } from "./config";

export const acme = definePlatform(ACME_PLATFORM, {
  config: configSchema,
  lifecycle: {
    createClient: ({ config }): Promise<FusorClient<AcmePayload>> =>
      Promise.resolve(
        fusor<AcmePayload>(ACME_PLATFORM, makeVerify(config))
      ),
  },
  user: { resolve: resolveUser },
  space: { create: createSpace },
  messages: handleMessages,
  send,
});
```

Consumers install and register the package like any other Spectrum provider:

```ts
import { acme } from "@your-scope/spectrum-acme";
import { Spectrum } from "spectrum-ts";

const app = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET,
  providers: [
    acme.config({
      apiKey: process.env.ACME_API_KEY!,
      webhookSigningSecret: process.env.ACME_WEBHOOK_SECRET!,
    }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(`Echo: ${message.content.text}`);
  }
}
```

## 10. Configure the upstream webhook

The external platform must send webhooks to a URL whose first path segment is
the canonical platform ID:

```text
https://<project-slug>.<fusor-ingress-root>/acme
```

If the platform exposes a webhook-management API, registration can be part of
startup. Telegram reads `projectConfig?.slug`, compares the current URL, and
only updates it when necessary:

```ts
lifecycle: {
  createClient: async ({
    config,
    projectConfig,
  }): Promise<FusorClient<AcmePayload>> => {
    if (projectConfig?.slug) {
      await ensureWebhook(config, projectConfig.slug);
    }
    return fusor<AcmePayload>(ACME_PLATFORM, makeVerify(config));
  },
},
```

Make registration idempotent and fail startup with a secret-free error if it
cannot complete. If the platform has no registration API, document the exact
URL and secret setup for an operator to perform manually. Do not log webhook
secrets, API tokens, signed bodies, or token-bearing URLs.

## Failure and delivery semantics

- Fusor delivery is at-least-once. Deduplicate durable side effects using a
  stable platform message or event ID.
- An authentication or payload-validation failure in `verify` rejects the
  event. It should not be retried as ordinary application work.
- `messages` should only throw when a verified payload itself cannot be mapped
  safely. Do not perform transient downstream work there and then poison the
  delivery when that work fails.
- The callback passed to `app.webhook()` runs after the synchronous reply is
  computed. Its error does not change that reply; it owns its own retry and
  durability policy.
- `respond()` must be called before the messages handler returns. Use it for a
  platform protocol response, not as an application acknowledgement.
- Avoid eager media downloads or other slow calls in the acknowledgement path.

## Testing the adapter

Keep the authentication, mapping, and outbound seams independently testable.

### Configuration

- required fields, defaults, and invalid formats,
- explicit config taking precedence over automatic environment fallback,
- exact `SPECTRUM_<PLATFORM>_<FIELD>` names for string fields.

### Verification

- a valid signature and fresh timestamp,
- missing, malformed, and mismatched signatures,
- stale and future timestamps outside the replay window,
- tampered raw body bytes,
- malformed JSON and structurally invalid payloads,
- lowercase header lookup.

### Inbound mapping

- every supported event maps to the intended content and IDs,
- ignored event types and self-authored echoes return `undefined`,
- senderless signals remain valid,
- multi-part events preserve ordering and grouping,
- media bytes are not fetched until `read()` is called,
- protocol challenges call `respond()` without emitting a message.

### Outbound dispatch

- each supported `Content` type calls the right platform API with the right
  space and target IDs,
- message-producing operations return records,
- ID-less reactions receive a deterministic synthetic ID,
- control operations return `undefined`,
- unsupported content throws `UnsupportedError`,
- thrown errors and telemetry never expose secrets.

### Lifecycle and packaging

- webhook registration is idempotent and uses the canonical platform ID,
- any cached client is available through `store` and is cleaned up when needed,
- the built package imports under every advertised runtime,
- type checks and tests run under the Node and Bun versions the package claims
  to support.

## Common mistakes

- Using different strings for `definePlatform`, `fusor`, and the webhook URL.
- Copying the retired `defineFusorPlatform`, `space.resolve`,
  `events.messages`, or `actions.send` APIs from an old guide.
- Writing `messages` as an untyped inline arrow and accidentally selecting the
  regular-provider overload.
- Verifying a reserialized JSON object rather than the exact `rawBody`.
- Treating the branded Fusor client as the platform's outbound SDK.
- Returning `undefined` for a successful reaction or another operation for
  which Spectrum needs a message handle.
- Downloading attachments while the webhook is waiting for a reply.
- Throwing on unknown but harmless event types instead of ignoring them.
- Assuming a new platform requires an allowlist change inside Fusor ingress.

## Ready-to-publish checklist

- [ ] One canonical lowercase snake-case platform constant is used everywhere.
- [ ] `config` validates credentials and documents automatic environment keys.
- [ ] `verify` authenticates exact bytes, uses constant-time comparison where
      applicable, applies replay protection, and validates the parsed payload.
- [ ] `messages` is explicitly typed as `FusorMessages` and ignores echoes.
- [ ] Inbound records carry stable IDs, space IDs, sender IDs when known, and
      valid timestamps.
- [ ] Media reads are lazy.
- [ ] `send` returns records for message-producing operations and throws
      `UnsupportedError` for unsupported content.
- [ ] `user.resolve` and `space.create` match the platform's addressing model.
- [ ] Upstream webhook registration or manual setup is documented.
- [ ] At-least-once delivery and deduplication expectations are documented.
- [ ] Config, verification, inbound, outbound, lifecycle, and package imports
      are tested.
- [ ] The README includes installation, configuration, webhook setup, supported
      content, and a minimal usage example.

## Current references

- [Telegram provider wiring](./packages/telegram/src/index.ts)
- [Telegram platform ID and config](./packages/telegram/src/config.ts)
- [Telegram verification](./packages/telegram/src/verify.ts)
- [Telegram inbound mapping](./packages/telegram/src/inbound/messages.ts)
- [Telegram outbound dispatch](./packages/telegram/src/outbound/send.ts)
- [Telegram webhook registration](./packages/telegram/src/webhook.ts)
- [Fusor provider types](./packages/core/src/fusor/types.ts)
- [`definePlatform` overloads](./packages/core/src/platform/define.ts)
- [Provider authoring exports](./packages/core/src/authoring.ts)
- [Custom platform API guide](./docs/custom-platforms.mdx.vel)
