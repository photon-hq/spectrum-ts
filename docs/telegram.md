# Telegram provider

The Telegram provider connects a Telegram **bot** to Spectrum. Inbound updates
arrive over [Fusor](./fusor.md) (webhook delivery); outbound sends go to the
Telegram **Bot API**. Both directions run on
[`@photon-ai/telegram-ts`](https://github.com/photon-hq/telegram-api) — the
generated, type-safe Bot API client — so the provider holds **no** hand-written
HTTP client of its own.

```ts
import { Spectrum } from "@photon-ai/spectrum-ts";
import { telegram } from "@photon-ai/spectrum-ts/providers/telegram";

const app = Spectrum({
  providers: [telegram.config({ botToken: process.env.TELEGRAM_BOT_TOKEN! })],
});
```

---

## Design

Telegram runs in **fusor mode**: `lifecycle.createClient` returns a `fusor(...)`
client (platform + `verify`), not a long-lived SDK client. Two principles shape
the implementation:

1. **Receiving is pure parsing.** `verify` does not need a Bot API client — an
   inbound webhook is just bytes to validate and parse. It checks the webhook
   secret token and parses the `Update`; that's the whole payload.
2. **A client is created inline, never cached.** `createTelegramClient(...)`
   makes **no** network call, so building one costs nothing. `send` and the
   inbound media-download path each construct one from `config` on demand. There
   is no store-cached client and nothing to dispose.

Because the Fusor `messages` handler receives the full hook ctx
(`{ payload, respond, config, store, projectConfig }`), the inbound mapper reads
`config` directly from its ctx — the client is **not** threaded through the
payload.

---

## Inbound (`verify` → `messages`)

```text
webhook bytes
  → verify(config)      secret-token check + parse → Update         (no client)
  → handleMessages(ctx) Update + config → ProviderMessageRecord | undefined
  → media read()        getFile + authenticated fetch, lazily       (client built inline)
```

- **`verify(config)`** (`verify.ts`) — validates the
  `X-Telegram-Bot-Api-Secret-Token` header (timing-safe; skipped when no
  `webhookSecret` is set — Telegram does not HMAC-sign the body) and parses the
  JSON body into an `Update`. A bad secret or malformed body throws, which Fusor
  turns into a `400` (no retry). The payload is the bare `Update`.
- **`handleMessages({ payload, config })`** (`inbound/messages.ts`) — maps the
  `Update` to a `ProviderMessageRecord`. It reads `config` from the ctx to derive
  the bot's own id (`botIdFromToken(config.botToken)`) and drop self-authored
  updates, and to build lazy media readers.
- **Lazy media** (`inbound/media.ts`) — each attachment's `read()` is
  `() => downloadFile(config, fileId)`. Nothing is fetched on the webhook-ack
  path; bytes download only when a consumer calls `read()` (and the content
  builders memoize it, so a file downloads once).

### What inbound surfaces (v1)

| Update | Mapped to |
| --- | --- |
| `message` / `channel_post`, text | `text` content |
| `message` / `channel_post`, media | `attachment` (or `voice`); caption + media → `group` |
| `message_reaction` (emoji added) | `reaction` targeting the message |

Media detection order: `voice → video_note → animation → video → audio →
document → photo → sticker` (`animation` also sets `document`, so order matters).
Voice notes become `voice`; everything else becomes an `attachment`.

Ignored (returns `undefined`): edited messages, callback queries, polls,
membership changes, and reaction **removals** (empty `new_reaction`).

---

## Outbound (`send`)

`send({ space, content, config })` (`outbound/send.ts`) builds a photon client
inline and dispatches by content type. Message-producing content is mapped to a
small `TelegramSendSpec` by the pure `buildSend` (`outbound/message.ts`) and run
through `executeSpec`; fire-and-forget signals call photon's typed functions
directly.

| Content | Bot API call |
| --- | --- |
| `text` | `sendMessage` |
| `richlink` | `sendMessage` (Telegram auto-unfurls the URL) |
| `attachment` (image) | `sendPhoto` |
| `attachment` (video) | `sendVideo` |
| `attachment` (other) | `sendDocument` |
| `voice` | `sendVoice` |
| `contact` | `sendDocument` (vCard `contact.vcf`) |
| `reply` | wraps the inner send with `reply_parameters` |
| `custom` | the named Bot API method, verbatim |
| `group` | one message per item (returns the last) |
| `reaction` | `setMessageReaction` (emoji pre-validated) → `undefined` |
| `typing` | `sendChatAction` (`start` only; `stop` is a no-op) → `undefined` |
| `edit` | `editMessageText` (text only) → `undefined` |

Unsupported (throws `UnsupportedError`): `poll`, `poll_option`, `effect`,
`rename`, `avatar`. Reach any other Bot API method through `custom`.

---

## The two photon gaps (the only non-typed-call glue)

photon `10.0.0` covers every JSON Bot API method with typed functions
(`sendMessage`, `setMessageReaction`, `sendChatAction`, `editMessageText`,
`getFile`, …). Two things it cannot do directly, both bridged in `client.ts`:

1. **Raw-byte uploads.** Typed `sendPhoto`/`sendDocument`/`sendVoice` accept only
   a `string` file ref (file_id/URL), and photon doesn't export its form
   serializer. So `executeSpec` uploads via photon's own low-level
   `client.post(url, body, …)`: the file is wrapped in a `File` (so the multipart
   part keeps its filename), a small inlined serializer turns the body into
   `FormData`, and `headers: { "Content-Type": null }` drops the default JSON
   header so fetch sets the multipart boundary. Still photon — just not the
   generated wrapper.
2. **File-byte download.** photon's `getFile` returns metadata only, and the file
   endpoint (`/file/bot<token>/<path>`) is not a Bot API JSON method. So
   `downloadFile` calls `getFile` (via photon) for the path, then does **one**
   raw `fetch` for the bytes — the only line in the provider that reaches Telegram
   outside photon. The token-bearing URL is never put into a thrown error.

Errors from photon surface as `TelegramApiError` (token-free).

---

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `botToken` | yes | `<id>:<token>` from @BotFather. The `<id>` prefix is the bot's own id (self-echo drop). |
| `webhookSecret` | no | The `secret_token` passed to `setWebhook`; verified against the inbound header. Omit to skip the check. |
| `baseUrl` | no | Bot API origin; defaults to `https://api.telegram.org`. Override for a local Bot API server. |

---

## File map

| File | Responsibility |
| --- | --- |
| `index.ts` | `definePlatform` wiring (fusor mode) |
| `config.ts` | config schema, `TELEGRAM_PLATFORM`, `botIdFromToken` |
| `verify.ts` | `verify(config)` — secret check + parse `Update` |
| `client.ts` | `telegramClient`, `executeSpec`, `downloadFile` (all over photon) |
| `types.ts` | photon type re-exports, `TelegramPayload = Update`, send DTOs |
| `space.ts` | user resolution + `space.create` (single-user private chats; existing chats go through `space.get(chatId)`) |
| `reactions.ts` | allowed reaction-emoji set + normalization |
| `inbound/messages.ts` | `handleMessages` — `Update` → record |
| `inbound/media.ts` | media detection + lazy `read()` |
| `outbound/message.ts` | `buildSend` — content → `TelegramSendSpec` (pure) |
| `outbound/send.ts` | dispatcher; builds the client inline |

---

## Testing

Tests live under `test/providers/telegram/`. The seam is `globalThis.fetch`:
because `send` and the inbound `read()` build the photon client inline from
`config` (which has no `fetch` field), there is no client to inject — a per-test
`spyOn(globalThis, "fetch")` cleanly intercepts the real path and exercises
photon's actual request serialization.

- `verify.test.ts` — secret-token cases + `Update` parsing (pure).
- `outbound/message.test.ts` — `buildSend` content→method/params/file mapping
  (pure, no client).
- `outbound/send.test.ts` — `send` end to end via a `fetch` spy: `chat_id`
  injection, multipart uploads (filename preserved), reply threading, group
  fan-out, reaction validation, typing/edit, unsupported.
- `inbound/messages.test.ts` — record mapping for all media kinds, channel posts,
  self-echo drop, reactions; the lazy-download test drives `getFile` + the file
  fetch through the `fetch` spy.
