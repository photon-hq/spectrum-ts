# Discord provider

The Discord provider connects a Discord **bot** to Spectrum. Inbound events
arrive over [Fusor](./fusor.md) — Fusor holds the Discord **Gateway** connection
(using the bot token) and relays each dispatch frame (`{ t, d }`) to Spectrum.
Outbound sends call the Discord **REST API** (v10) directly. The REST client is
the generated [`@photon-ai/discord-ts`](https://github.com/photon-hq/discord-api).

```ts
import { Spectrum } from "@photon-ai/spectrum-ts";
import { discord } from "@photon-ai/spectrum-ts/providers/discord";

const app = Spectrum({
  providers: [
    discord.config({
      botToken: process.env.DISCORD_BOT_TOKEN!,
      applicationId: process.env.DISCORD_APPLICATION_ID!,
    }),
  ],
});
```

---

## Design

Discord runs in **fusor mode**: `lifecycle.createClient` returns a `fusor(...)`
client (platform + `verify`), not a long-lived SDK client. Two principles shape
the implementation:

1. **Receiving is parsing.** `verify` does not need a REST client — a
   relayed Gateway event is just bytes to parse. It decodes the body into a
   `{ t, d }` dispatch and returns it as the payload. There is **no** per-event
   signature check: Fusor's authenticated plane is the trust boundary. Unlike
   Telegram, there is also **no** webhook to self-register — Fusor owns the
   Gateway connection, so the provider only wires up verify/map.
2. **A REST client is created inline, never cached.** `discordClient(config)`
   makes **no** network call, so building one costs nothing. `send` and the
   inbound poll-vote path each construct one from `config` on demand. There is no
   store-cached client and nothing to dispose.

Because the Fusor `messages` handler receives the full hook ctx
(`{ payload, config, store, … }`), the inbound mapper reads `config` directly
from its ctx — the client is **not** threaded through the payload.

---

## Inbound (`verify` → `messages`)

```text
relayed Gateway frame
  → verify(config)       parse → { t, d } dispatch                     (no client)
  → handleMessages(ctx)  dispatch + config → ProviderMessageRecord | undefined
  → poll-vote resolve    getChannelMessage to rebuild poll options     (client built inline)
```

- **`verify(config)`** (`verify.ts`) — parses the relayed body into a
  `DiscordPayload` (`{ t, d }`). No signature, no client.
- **`handleMessages({ payload, config, store })`** (`inbound/messages.ts`) —
  switches on `payload.t` and maps the dispatch to a `ProviderMessageRecord`. It
  reads `config` from the ctx to drop the bot's own events (a bot's user id
  equals its `applicationId`).

### What inbound surfaces (v1)

| Dispatch | Mapped to |
| --- | --- |
| `MESSAGE_CREATE` (text/attachments) | `text` / `attachment` / `voice`; text + multiple attachments → `group` (one message per part) |
| `MESSAGE_CREATE` (poll) | `poll` content |
| `MESSAGE_UPDATE` | `edit` (rewrites the original message) |
| `MESSAGE_DELETE` | `unsend` (retracts the message) |
| `MESSAGE_REACTION_ADD` | `reaction` targeting the message |
| `MESSAGE_REACTION_REMOVE` | `unsend` (retracts the reaction) |
| `MESSAGE_POLL_VOTE_ADD` | `poll_option` with `selected: true` |
| `MESSAGE_POLL_VOTE_REMOVE` | `poll_option` with `selected: false` |

Typing, presence and every other dispatch type are ignored (return `undefined`).

Notes:

- **Self-echo drop.** Events whose author/actor id equals `applicationId` are
  dropped so the bot never re-ingests its own messages, edits, reactions or
  votes. `MESSAGE_UPDATE` frames with no author (Discord's own edits, e.g.
  auto-attaching a link embed) are also ignored.
- **Synthetic event ids.** Discord reuses the original message id for
  edits/deletes and assigns none to reactions/votes, so the mapper synthesizes
  distinct, stable event ids (e.g. `edit:<channel>:<msg>`,
  `reaction:<channel>:<msg>:<user>:<emoji>`) — a removal derives the same base id
  as its add so the `unsend` resolves back to what it retracts.
- **Poll-vote resolution.** Discord poll-vote dispatches carry no poll structure,
  so the handler reconstructs the poll's options from the source message. A
  `MESSAGE_CREATE` poll caches its reconstructed shape in the platform `store`
  (keyed by message id); the first vote on an uncached poll fetches the message
  once (`getChannelMessage`) and caches it, so sibling votes skip the round trip.
- **Lazy media.** Attachment bytes download from Discord's pre-signed CDN URLs
  (unauthenticated) only when a consumer reads the content, not on the ack path.

---

## Outbound (`send`)

`send({ space, content, config })` (`outbound/send.ts`) builds the REST client
inline and dispatches by content type. Message-producing content is mapped to a
small `DiscordSendSpec` by the pure `buildSend` (`outbound/message.ts`) and run
through `createChannelMessage`; reactions and fire-and-forget signals call the
client's helpers directly.

| Content | Discord REST |
| --- | --- |
| `text` / `markdown` | `POST /channels/{id}/messages` (`content` field) |
| `richlink` | message create (Discord auto-embeds the URL) |
| `attachment` / `voice` / `contact` | multipart message create (contact → vCard) |
| `poll` | native Discord poll (question + up to 10 answers) |
| `reply` | message create with `message_reference` |
| `reaction` | `PUT …/reactions/{emoji}` → synthetic record id (Discord assigns none) |
| `edit` | `PATCH …/messages/{mid}` (text/markdown only) → `undefined` |
| `typing` | `POST …/typing` (`start` only; auto-clears after ~10s) → `undefined` |
| `read` | no-op — bots cannot mark messages read → `undefined` |
| `group` | one message per item (returns the last as the reply target) |
| `custom` | raw JSON body passed verbatim to message-create |

Unsupported (throws `UnsupportedError`): `streamText`, `poll_option` (bots cannot
cast poll votes), `effect`, `rename`, `avatar`. Reach any other message-create
body through `custom`.

Message-id targets (for `reaction`/`edit`) go through `parseMessageId`, which
accepts a bare snowflake and unwraps flattened group-item ids (`"<id>:0"` →
`"<id>"`), validating at parse time to fail fast.

---

## Threads (instance actions)

A Discord thread id is itself a channel snowflake, so sending and receiving in an
**existing** thread already works through the normal space path —
`discord(spectrum).space.get(threadId).send(...)`. To open a **new** thread, the
provider exposes two instance actions (`outbound/thread.ts`) that surface on the
platform instance and return the new thread's id:

- **`startThread(message, name, options?)`** — start a thread hung off an
  existing message (channel + message taken from `message`).
- **`createThread(channelId, name, options?)`** — open a standalone text-channel
  thread (public by default, private via `options.private`). Forum channels
  require a starter message and are not supported here.

Options:

| Option | Applies to | Notes |
| --- | --- | --- |
| `autoArchiveDuration` | both | Minutes of inactivity before Discord auto-archives (one of Discord's fixed durations). Defaults to the channel's setting. |
| `rateLimitPerUser` | both | Per-user slow-mode, in seconds. |
| `private` | `createThread` | Open a private thread (type 12) instead of public (type 11). |
| `invitable` | `createThread` | Whether non-moderators may add others to a private thread. |

```ts
const threadId = await discord(app).startThread(message, "follow-up", {
  autoArchiveDuration: 1440,
});
await discord(app).space.get(threadId).send(asText("posted into the thread"));
```

---

## Spaces

`space.create` (`space.ts`) resolves the channel to send into:

- **Single recipient** → opens (or returns the existing) DM channel via
  `POST /users/@me/channels`. Discord rejects this with `403` when the bot shares
  no guild with the user.
- **Multiple recipients** → rejected: bots cannot create group DMs.
- **Existing channels, threads and DMs** → addressed directly by id via
  `space.get(id)` (a thread id is just another channel snowflake).

---

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `botToken` | yes | Bot token from the Discord Developer Portal, shape `<id>.<ts>.<hmac>`. Used for outbound API calls and media downloads. |
| `applicationId` | yes | The application's own numeric snowflake. For a bot this equals the bot user's id, so it is used to drop self-authored events (self-echo). Modern tokens no longer encode it, so it is supplied explicitly. |
| `baseUrl` | no | Discord API origin; defaults to `https://discord.com/api/v10`. Override for a local test server. |

---

## File map

| File | Responsibility |
| --- | --- |
| `index.ts` | `definePlatform` wiring (fusor mode) + `startThread`/`createThread` actions |
| `config.ts` | config schema, `DISCORD_PLATFORM`, `DEFAULT_BASE_URL` |
| `verify.ts` | `verify(config)` — parse the relayed `{ t, d }` dispatch |
| `client.ts` | `discordClient` + REST helpers (`createChannelMessage`, `editChannelMessage`, `getChannelMessage`, `addReaction`, `triggerTyping`, `createDmChannel`, thread starts) |
| `types.ts` | Gateway dispatch types, DTO shapes, `DiscordPayload` |
| `space.ts` | user resolution + `space.create` (DM open; existing channels via `space.get(id)`) |
| `util.ts` | `FormData` serialization for multipart uploads, attachment download |
| `inbound/messages.ts` | `handleMessages` — dispatch → record |
| `inbound/poll.ts` | poll reconstruction + answer-id → option lookup |
| `inbound/media.ts` | attachment → content mapping |
| `outbound/message.ts` | `buildSend` — content → `DiscordSendSpec` (pure); `parseMessageId` |
| `outbound/send.ts` | dispatcher; builds the client inline |
| `outbound/thread.ts` | `startThread` / `createThread` + options |

---

## Testing

Tests live under `test/providers/discord/`. The seam is `globalThis.fetch`:
because `send` and the poll-vote path build the REST client inline from `config`
(which has no `fetch` field), there is no client to inject — a per-test
`spyOn(globalThis, "fetch")` intercepts the real request path.

- `inbound/messages.test.ts` — dispatch → record mapping for all event kinds
  (messages, attachments/groups, polls, edits, deletes, reactions and removals,
  poll votes), including self-echo drop and the poll-vote fetch/cache path.
- `outbound/message.test.ts` — pure `buildSend` content→spec mapping (polls,
  files, replies) and `parseMessageId` cases.
- `outbound/thread.test.ts` — `startThread`/`createThread` request bodies and
  options (auto-archive, slow-mode, private/invitable).
