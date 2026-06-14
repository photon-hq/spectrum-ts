# X provider

The X provider connects account-activity DMs to Spectrum in **fusor mode**:
inbound comes from webhook events (`verify` + `messages`), and outbound sends
text and media DMs via the X REST API.

## Direct mode (self-host)

Bring your own currently-valid X API credentials:

```ts
import { Spectrum } from "@photon-ai/spectrum-ts";
import { x } from "@photon-ai/spectrum-ts/providers/x";

const app = Spectrum({
  providers: [
    x.config({
      consumerSecret: process.env.X_CONSUMER_SECRET!,
      accessToken: process.env.X_ACCESS_TOKEN!,
      xUserId: process.env.X_USER_ID!,
      appBearerToken: process.env.X_APP_BEARER_TOKEN!,
    }),
  ],
});
```

When `projectConfig.slug` is available, startup calls `ensureWebhook` to register
the Fusor edge URL with X (see [Webhook registration](#webhook-registration-direct-mode)).

## Cloud mode (Spectrum Cloud OAuth)

OAuth connect and token refresh live in **spectrum-cloud**. Pass
`appBearerToken` in `x.config()` so spectrum-ts registers the Fusor webhook at
`Spectrum()` startup (same as direct mode).

```ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [
    x.config({
      appBearerToken: process.env.X_APP_BEARER_TOKEN!,
      // optional: pin one connected bot when multiple x_accounts exist
      xUserId: process.env.X_USER_ID,
      // optional: override https://{slug}.spctrm.dev/x (local ngrok)
      webhookBaseUrl: process.env.PUBLIC_X_INGRESS_URL,
    }),
  ],
});
```

Cloud mode requires `projectId` + `projectSecret` on `Spectrum()`. Without
`appBearerToken`, webhook registration is skipped — register manually or add
the token before startup.

This path is separate from the **spectrum-x / LightAuth** stack
(`POST /projects/:id/x/tokens` → gRPC). Fusor mode uses
`POST /projects/:id/x/credentials` instead (see below).

---

## What v1 supports

- Inbound DMs from X webhook payloads (multiple envelope shapes — legacy Account Activity, `dm.received`, and `chat.received`)
- Inbound media (image, GIF, video) with lazy `read()`; caption + media → `group` of `[text, attachment]`
- CRC challenge handling (`GET ?crc_token=...`)
- Signed webhook verification (`x-twitter-webhooks-signature`)
- Outbound text DMs and media attachments (images, GIFs, video via chunked upload)
- Outbound `group` of one attachment plus optional text caption (single DM carrying both)
- Fusor stream + webhook transport compatibility (`app.messages` and `app.webhook`)
- Cloud mode via Spectrum Cloud credential exchange (direct mode unchanged)

Out of scope in v1: group DMs (multi-party), reactions, markdown, reply threading, typing/edit/streamText, and other rich content types Telegram supports.

Webhook delivery is registered by spectrum-ts at startup (`ensureWebhook` — Account Activity webhook + `/subscriptions/all`). spectrum-cloud stores OAuth tokens only; it does not provision X webhook subscriptions.

---

## Design

Like Telegram, the X provider keeps fusor inbound and outbound API calls
separate:

- `createClient` returns `fusor("x", verify(...))` (direct config) or
  `fusor("x", makeVerify(auth))` (cloud mode)
- `verify` handles:
  - `GET`: CRC token extraction
  - `POST`: signature verification + JSON parse
- `messages` maps parsed DM events to `ProviderMessageRecord` (text, media, or `custom` for undecodable `chat.received` payloads)
- `send` uploads media via `POST /2/media/upload` when needed, then calls `POST /2/dm_conversations/with/:participant_id/messages`

Cloud mode adds a **token sidecar** (`providers/x/auth.ts`): a refresh loop
calls `POST /projects/:id/x/credentials` and stashes runtime creds on the
platform `store`. Outbound and CRC replies read resolved tokens; Fusor transport
is unchanged.

This means one provider implementation works in both deployment styles:

- long-running stream consumer (`for await (… of app.messages)`)
- request-scoped webhook route (`await app.webhook(req, handler)`)

---

## Configuration

### Direct mode

| Field | Required | Notes |
| --- | --- | --- |
| `consumerSecret` | yes | X app consumer/API secret. Used for CRC HMAC + webhook signature verification. |
| `accessToken` | yes | User-context OAuth token used for outbound DM sends and account webhook subscription. |
| `xUserId` | yes | Connected account user id (numeric string). Used for echo filtering and conversation routing. |
| `appBearerToken` | yes | App-only bearer token for webhook list/create endpoints. |
| `baseUrl` | no | X API base URL, defaults to `https://api.x.com`. |

### Cloud mode

| Field | Required | Notes |
| --- | --- | --- |
| `xUserId` | no | Pin one bot when multiple `x_accounts` are linked. Defaults to the sole account. |
| `appBearerToken` | no | App-only bearer for webhook list/create at startup. When set with a project `slug`, calls `ensureWebhook`. |
| `webhookBaseUrl` | no | Override Fusor edge base URL instead of `https://{slug}.spctrm.dev/x`. |
| `projectId` / `projectSecret` | yes | On `Spectrum()` — used to mint credentials from cloud. |

Your X app/token must include DM scopes (`dm.read`, `dm.write`) and required
companion scopes in the X developer configuration.

---

## Spectrum Cloud API contract (Fusor path)

**Prerequisite:** Implemented in **spectrum-cloud**, not in spectrum-ts. The SDK
sidecar (`providers/x/auth.ts`) is ready to consume this contract; without it,
`createCloudAuth` fails at startup when no accounts are linked or the endpoint
is unavailable.

### `POST /projects/:projectId/x/credentials`

- **Auth:** Basic `projectId:projectSecret` (same as Slack `/slack/tokens`)
- **Response:**

```ts
{
  auth: Record<string, string>; // xUserId → refreshed X user access token
  accounts: Record<string, { xUserId: string }>;
  consumerSecret: string; // app API secret for webhook HMAC (X_CLIENT_SECRET)
  expiresIn: number; // seconds until credentials should be re-fetched
}
```

- **Behavior:** Load active `x_accounts`, refresh rows near expiry (same buffer
  as internal verify), return fresh user access tokens. Does **not** replace
  existing `POST /x/tokens` (LightAuth JWTs for spectrum-x gRPC).

### OAuth connect (internal `POST /projects/:id/x`)

Upserts `x_accounts` after PKCE exchange. Webhook registration is handled by
spectrum-ts at app startup when `appBearerToken` is passed in `x.config()`.

---

## Webhook registration

When `projectConfig.slug` is available and `appBearerToken` is configured
(direct mode always; cloud mode when passed in `x.config()`), startup calls
`ensureWebhook`:

1. Resolve expected URL: `https://{slug}.${SPECTRUM_SUPER_WEBHOOK ?? "spctrm.dev"}/x`
2. `GET /2/webhooks` (app bearer) and reuse matching URL if present
3. Otherwise `POST /2/webhooks` with `{ url }`
4. `POST /2/account_activity/webhooks/:webhook_id/subscriptions/all` (user token)

Subscription `409` is treated as already subscribed.

---

## Inbound (`verify` → `messages`)

```text
webhook bytes
  → verify(config)      CRC (GET) or signature check + JSON parse → XPayload
  → handleMessages(ctx) parsed DM events → ProviderMessageRecord | undefined
  → media read()        authenticated fetch of media URL, lazily
```

- **`verify(config)`** (`verify.ts`) — on `GET`, extracts `crc_token` for CRC
  challenge responses; on `POST`, verifies `x-twitter-webhooks-signature` (HMAC
  with `consumerSecret`) and parses the JSON body into an `XPayload`.
- **`handleMessages({ payload, respond, config, store })`** (`inbound/messages.ts`)
  — maps parsed events to records. CRC challenges are answered via `respond` and
  return `undefined`. Outbound echoes and messages from `xUserId` are dropped.
- **Lazy media** — each attachment's `read()` fetches bytes from the DM media URL
  with the user's bearer token. Nothing is fetched on the webhook-ack path.

### What inbound surfaces (v1)

| Event | Mapped to |
| --- | --- |
| Text DM | `text` content |
| Media-only DM | `attachment` (image / GIF / video) |
| Caption + media | `group` of `[text, attachment]` |
| `chat.received` (undecodable body) | `custom` with `encodedEvent` |

Ignored (returns `undefined`): outbound/self echo events, empty text with no media.

---

## Outbound (`send`)

`send({ space, content, config, store })` (`outbound/send.ts`) resolves
credentials (direct config or cloud sidecar), uploads media when needed
(`outbound/media.ts`), and sends via the participant DM endpoint.

| Content | X API |
| --- | --- |
| `text` | DM with `{ text }` |
| `attachment` | Chunked upload → DM with `{ attachments: [{ media_id }] }` |
| `group` | One attachment + optional text caption in a **single** DM (not N messages) |

Supported attachment MIME types: `image/*`, `image/gif`, `video/*`. Other MIME
types throw `UnsupportedError` before upload starts.

Unsupported (throws `UnsupportedError`): `markdown`, `richlink`, `voice`,
`contact`, `reply`, `custom`, `reaction`, `typing`, `edit`, `streamText`,
`poll`, `poll_option`, `effect`, `rename`, `avatar`, and multi-attachment
`group` shapes.

---

## Outbound routing

`space.create(user)` stores the recipient id as `space.id`. If you are replying
inside a previously received DM, `space.id` is the internal conversation id
(`a:b`). The provider resolves the recipient user id from that conversation
using `xUserId`, then sends via the participant endpoint.
