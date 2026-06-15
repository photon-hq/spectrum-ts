# X provider

The X provider connects account-activity DMs to Spectrum in **fusor mode**
([Fusor](./fusor.md)): inbound arrives via the Fusor edge
(`https://{slug}.spctrm.dev/x`), outbound sends through the X REST API v2.

X is **BYO-app** — the only config shape is direct credentials supplied by the
customer's own X developer app. There is no cloud credential sidecar
(`providers/x/auth.ts` was removed with the managed X module in spectrum-cloud).
Webhook registration, CRC/signature verification, OAuth2 refresh, and DM API
calls all run in the customer's runtime.

```ts
import { Spectrum } from "spectrum-ts";
import { ensureWebhook, resolveAccessToken, x } from "spectrum-ts/providers/x";

const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [
    x.config({
      consumerSecret,
      appBearerToken,
      xUserId,
      accessToken,
      // optional SDK-side refresh (all three or none):
      clientId,
      clientSecret,
      refreshToken,
      onTokensRefreshed,
    }),
  ],
});

// After the webhook server is listening — see [Webhook registration](#webhook-registration).
await ensureWebhook({ ... }, app.config!.slug);
```

Reference app: `x-testing-app` (`index.ts`, `lib/x-config.ts`).

---

## Design

Like Telegram, the X provider keeps fusor inbound and outbound API calls
separate:

1. **`createClient` returns `fusor("x", verify(config))`** — no long-lived X
   client. `verify` closes over `consumerSecret` only; it does not need a live
   access token.
2. **Outbound and inbound message handling resolve tokens at call time** via
   `resolveEffectiveConfig(config, store)` — either the configured
   `accessToken` or the current token held by the refresh sidecar.
3. **Webhook registration is intentionally not in `createClient`.** Creating an
   X webhook triggers a synchronous CRC; Fusor forwards that to `app.webhook()`,
   which must already be listening. The app calls the exported `ensureWebhook`
   after its HTTP server starts (Telegram registers in `createClient` because
   its CRC is not synchronous on create).

Two auth paths for user-context X API calls (outbound DMs + activity
subscriptions):

| Path | When | Module |
| --- | --- | --- |
| **OAuth2 refresh sidecar** | `clientId` + `clientSecret` + `refreshToken` all set | `direct-auth.ts` → `oauth.ts` |
| **Static credentials** | refresh trio omitted | `config.accessToken` as Bearer; subscribe may use OAuth 1.0a via `oauth1.ts` |

The sidecar refreshes directly against X (`POST /2/oauth2/token`), single-flight
deduped, renewal at ~80% TTL. X rotates refresh tokens — `onTokensRefreshed`
must persist the new one. On startup the sidecar refreshes immediately, so
`resolveAccessToken(app, config.accessToken)` is required before
`ensureWebhook` in refresh mode.

Spectrum Cloud's role is limited to the **generic Fusor edge** (project `slug`,
`platforms.x` routing). No X OAuth storage, `/x/credentials`, or token refresh
in cloud for this path.

---

## Inbound (`verify` → `messages`)

```text
webhook bytes
  → verify(config)           CRC (GET) or HMAC signature + JSON parse → XPayload
  → handleMessages(ctx)      parsed DM events → ProviderMessageRecord | undefined
  → attachment read()        authenticated fetch of media URL, lazily
```

- **`verify(config)`** (`verify.ts`) — on `GET`, extracts `crc_token` for CRC
  challenge responses; on `POST`, verifies `x-twitter-webhooks-signature` (HMAC
  with `consumerSecret`) and parses the JSON body into an `XPayload`. Does not
  touch the token sidecar.
- **`handleMessages({ payload, respond, config, store })`** (`inbound/messages.ts`)
  — maps parsed events to records. CRC challenges are answered via `respond` and
  return `undefined`. Outbound echoes and messages from `xUserId` are dropped.
  Reads `resolveEffectiveConfig` for the bearer used in lazy media fetches.
- **`parseWebhookPayload`** (`inbound/parser.ts`) — normalizes legacy Account
  Activity envelopes, `dm.received`, and `chat.received` into a common
  `ParsedWebhookEvent` shape.
- **Lazy media** — each attachment's `read()` fetches bytes from the DM media URL
  with the user's bearer token. Nothing is fetched on the webhook-ack path.

### What inbound surfaces (v1)

| Event | Mapped to |
| --- | --- |
| Text DM | `text` |
| Media-only DM | `attachment` (image / GIF / video) |
| Caption + media | `group` of `[text, attachment]` |
| `chat.received` (undecodable body) | `custom` with `encodedEvent` |

Ignored (returns `undefined`): outbound/self echo events, empty text with no
media.

X re-sends CRC challenges periodically (~30 min); `handleMessages` answers them
via `createCrcResponse` (`crc.ts`).

---

## Outbound (`send`)

`send({ space, content, config, store })` (`outbound/send.ts`) resolves
credentials, uploads media when needed (`outbound/media.ts` — chunked
`POST /2/media/upload`), and sends via `outbound/client.ts`
(`POST /2/dm_conversations/with/:participant_id/messages`).

| Content | X API |
| --- | --- |
| `text` | DM with `{ text }` |
| `attachment` | Upload → DM with `{ attachments: [{ media_id }] }` |
| `group` | One attachment + optional text caption in a **single** DM |

A Spectrum `group` maps to one X DM only when it is exactly one attachment with
an optional text caption — X allows at most one media attachment per DM.

Supported attachment MIME types: `image/*`, `image/gif`, `video/*`.

Unsupported (throws `UnsupportedError`): `markdown`, `richlink`, `voice`,
`contact`, `reply`, `custom`, `reaction`, `typing`, `edit`, `streamText`,
`poll`, `poll_option`, `effect`, `rename`, `avatar`, and multi-attachment
`group` shapes.

### Outbound routing

`space.create({ users: [{ id }] })` stores the recipient user id as `space.id`
(1:1 DMs only — group DM creation throws).

When replying inside a received DM, `space.id` is the internal conversation id
(`a:b`, see `conversation-id.ts`). `resolveRecipientUserId` picks the peer id
using `xUserId`, then sends via the participant endpoint.

---

## Webhook registration

Exported from `webhook.ts` — **not** called from `createClient`.

`ensureWebhook(input, slug, webhookBaseUrl?)`:

1. `webhookUrl(slug)` → `https://{slug}.{SPECTRUM_SUPER_WEBHOOK ?? "spctrm.dev"}/x`
   (overridable via `webhookBaseUrl` or `X_FUSOR_WEBHOOK_URL_OVERRIDE`)
2. `GET /2/webhooks` with app bearer — reuse matching URL
3. Else `POST /2/webhooks` with `{ url }`
4. For each event type in `DEFAULT_X_EVENT_TYPES` (`dm.received`, `dm.sent`,
   `chat.received`, `chat.sent`), `POST /2/activity/subscriptions` with
   user-context auth

List/create uses `appBearerToken`. Subscribe requires user-context auth: OAuth
1.0a when `consumerKey` + `consumerSecret` + `accessTokenSecret` are all
present (`oauth1Header`), else OAuth2 Bearer via `accessToken`. Subscription
409 / duplicate errors are treated as success.

---

## Configuration

Schema: `config.ts` (`directConfigSchema` — sole shape, aliased as `XConfig`).

| Field | Required | Notes |
| --- | --- | --- |
| `consumerSecret` | yes | CRC HMAC + webhook signature verification. |
| `accessToken` | yes | User-context token for outbound + subscribe. Bootstrap when refresh sidecar is active. |
| `xUserId` | yes | Numeric bot account id. Echo filter + conversation routing. |
| `appBearerToken` | yes | App-only bearer for `GET/POST /2/webhooks`. |
| `consumerKey` | no | OAuth 1.0a — subscribe signing. |
| `accessTokenSecret` | no | OAuth 1.0a — pairs with `consumerKey`. |
| `clientId` / `clientSecret` / `refreshToken` | no* | SDK refresh trio. Refine: all three or none. |
| `onTokensRefreshed` | no | Persist rotated refresh token. |
| `tokenUrl` | no | Default `https://api.twitter.com/2/oauth2/token`. |
| `baseUrl` | no | Default `https://api.x.com`. |
| `webhookBaseUrl` | no | Override Fusor edge base (dev tunnels). |

Required X app scopes: `dm.read`, `dm.write`, `users.read`, `tweet.read`;
`offline.access` when using SDK refresh.

`lookupXUserId(bearer, username)` (`users.ts`) resolves a numeric id via
`GET /2/users/by/username/{username}`.

---

## Public exports (`index.ts`)

| Export | Role |
| --- | --- |
| `x` | `definePlatform` provider |
| `ensureWebhook` / `webhookUrl` | Webhook registration (app-called) |
| `resolveAccessToken` | Sidecar-aware token for post-startup registration |
| `lookupXUserId` | Handle → numeric id |

---

## File map

| File | Responsibility |
| --- | --- |
| `index.ts` | `definePlatform` wiring; lifecycle (sidecar init, no auto webhook) |
| `config.ts` | Zod schema, `X_PLATFORM`, `hasRefreshCreds`, event type defaults |
| `direct-auth.ts` | OAuth2 refresh sidecar (store key `xDirectAuth`) |
| `oauth.ts` | `refreshXAccessToken` — refresh_token grant |
| `oauth1.ts` | OAuth 1.0a signing for subscribe calls |
| `resolve-config.ts` | `resolveEffectiveConfig` — sidecar token merge |
| `webhook.ts` | `ensureWebhook`, `webhookUrl` |
| `verify.ts` | `verify(config)` — CRC + signature |
| `crc.ts` | CRC response HMAC |
| `signature.ts` | `x-twitter-webhooks-signature` verification |
| `inbound/messages.ts` | `handleMessages` — payload → record |
| `inbound/parser.ts` | Legacy + v2 event normalization |
| `outbound/send.ts` | content dispatch |
| `outbound/media.ts` | chunked upload |
| `outbound/client.ts` | DM send API wrapper |
| `space.ts` | user resolution + 1:1 `space.create` |
| `conversation-id.ts` | internal `a:b` conversation ids |
| `users.ts` | `lookupXUserId` |

---

## Testing

Tests live under `test/providers/x/`. The seam is `globalThis.fetch` (webhook
registration, outbound send, media upload, OAuth refresh).

- `config.test.ts` — schema validation, refresh trio refine
- `verify.test.ts` — CRC parsing, signature verification
- `inbound/messages.test.ts` — record mapping, echo drop, CRC respond, lazy media
- `outbound/send.test.ts` — text/media/group send, routing, unsupported content
- `outbound/media.test.ts` — chunked upload sequence
- `webhook.test.ts` — list/create/subscribe idempotency, OAuth1 subscribe header
- `direct-auth.test.ts` — single-flight refresh, renewal timer, `onTokensRefreshed`
- `oauth.test.ts` / `oauth1.test.ts` — token refresh + signing

---

## v1 scope

**In scope:** 1:1 DMs (text, media, caption+media), fusor stream + webhook
transport, SDK-side OAuth2 refresh, OAuth 1.0a subscribe fallback.

**Out of scope:** group DMs (multi-party), reactions, markdown, reply threading,
typing/edit/streamText, polls, and other rich content types Telegram supports.
