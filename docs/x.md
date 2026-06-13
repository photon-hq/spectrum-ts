# X provider

The X provider connects account-activity DMs to Spectrum in **fusor mode**:
inbound comes from webhook events (`verify` + `messages`), and outbound sends
text DMs via X REST.

```ts
import { Spectrum } from "@photon-ai/spectrum-ts";
import { x } from "@photon-ai/spectrum-ts/providers/x";

const app = Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
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

---

## What v1 supports

- Inbound DMs from X webhook payloads (legacy AAA + Activity API `dm.received`)
- CRC challenge handling (`GET ?crc_token=...`)
- Signed webhook verification (`x-twitter-webhooks-signature`)
- Outbound text DMs
- Fusor stream + webhook transport compatibility (`app.messages` and `app.webhook`)

Out of scope in v1: media, group DMs, reactions, and cloud token exchange.

---

## Design

Like Telegram, the X provider keeps fusor inbound and outbound API calls
separate:

- `createClient` returns `fusor("x", verify(config))`
- `verify` handles:
  - `GET`: CRC token extraction
  - `POST`: signature verification + JSON parse
- `messages` maps parsed DM events to `ProviderMessageRecord`
- `send` calls `POST /2/dm_conversations/with/:participant_id/messages`

This means one provider implementation works in both deployment styles:

- long-running stream consumer (`for await (… of app.messages)`)
- request-scoped webhook route (`await app.webhook(req, handler)`)

---

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `consumerSecret` | yes | X app consumer/API secret. Used for CRC HMAC + webhook signature verification. |
| `accessToken` | yes | User-context OAuth token used for outbound DM sends and account webhook subscription. |
| `xUserId` | yes | Connected account user id (numeric string). Used for echo filtering and conversation routing. |
| `appBearerToken` | yes | App-only bearer token for webhook list/create endpoints. |
| `baseUrl` | no | X API base URL, defaults to `https://api.x.com`. |

Your X app/token must include DM scopes (`dm.read`, `dm.write`) and required
companion scopes in the X developer configuration.

---

## Webhook registration

In cloud mode (`projectConfig.slug` is available), startup calls `ensureWebhook`
to keep registration aligned with the project slug:

1. Resolve expected URL: `https://{slug}.${SPECTRUM_SUPER_WEBHOOK ?? "spctrm.dev"}/x`
2. `GET /2/webhooks` (app bearer) and reuse matching URL if present
3. Otherwise `POST /2/webhooks` with `{ url }`
4. `POST /2/account_activity/webhooks/:webhook_id/subscriptions/all` (user token)

Subscription `409` is treated as already subscribed.

---

## Outbound routing

`space.create(user)` stores the recipient id as `space.id`. If you are replying
inside a previously received DM, `space.id` is the internal conversation id
(`a:b`). The provider resolves the recipient user id from that conversation
using `xUserId`, then sends via participant endpoint.

Only `text` content is supported in v1. Other content types throw
`UnsupportedError`.
