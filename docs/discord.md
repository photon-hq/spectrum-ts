# Discord provider

The Discord provider connects a Discord **bot** to Spectrum. Inbound events
arrive over [Fusor](./fusor.md) — Fusor holds the Discord **Gateway** connection
(using the bot token) and relays each dispatch frame (`{ t, d }`) to Spectrum.
Outbound sends call the Discord **REST API** (v10) directly. The REST client is
generated [`@photon-ai/discord-ts`](https://github.com/photon-hq/discord-api).

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
client (platform + `verify`). Two principles shape
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
| `INTERACTION_CREATE` (`MESSAGE_COMPONENT`) | `custom` content (`raw.discord.type === "interaction"`) — a button click or select-menu submit |

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
- **Component interactions.** An `INTERACTION_CREATE` of type `MESSAGE_COMPONENT`
  (a click on a button or a select-menu submit from an outbound `components()`
  message) is **acknowledged first** — within Discord's 3-second window, via a
  silent `DEFERRED_UPDATE_MESSAGE` ack that shows no spinner and leaves the source
  message untouched — then surfaced as `custom` content. A handler narrows on
  `raw.discord.type === "interaction"` and reads `custom_id` (the id set when the
  component was sent), `values` (select choices), `component_type`, `message_id`,
  plus `interaction_id`/`token`. The id/token ride along so a future
  explicit-response API (edit the source message, ephemeral reply, open a modal)
  can use them; v1 has already acked, so any reply the handler sends is an ordinary
  channel message. Slash commands, autocomplete and modal submits are ignored.

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
| `embed` | Discord-only `embed(...)`: one message with up to 10 `RichEmbed`s + optional `content` text |
| `components` | Discord-only `components(...)`: one message with up to 5 action rows of buttons/select menus + optional `content` text |
| `reply` | message create with `message_reference` |
| `reaction` | `PUT …/reactions/{emoji}` → synthetic record id (Discord assigns none) |
| `edit` | `PATCH …/messages/{mid}` (text/markdown only) → `undefined` |
| `typing` | `POST …/typing` (`start` only; auto-clears after ~10s) → `undefined` |
| `read` | no-op — bots cannot mark messages read → `undefined` |
| `group` | one message per item (returns the last as the reply target) |
| `custom` | raw JSON body passed verbatim to message-create |

`embed` and `components` are **Discord-scoped content** (not part of the universal
`Content` model); see [Discord-specific content](#discord-specific-content) below.

Every outbound message also carries an `allowed_mentions` object resolved by
`resolveAllowedMentions` — see [Mentions](#mentions) below.

Unsupported (throws `UnsupportedError`): `streamText`, `poll_option` (bots cannot
cast poll votes), `effect`, `rename`, `avatar`. Reach any other message-create
body through `custom`.

Message-id targets (for `reaction`/`edit`) go through `parseMessageId`, which
accepts a bare snowflake and unwraps flattened group-item ids (`"<id>:0"` →
`"<id>"`), validating at parse time to fail fast.

---

## Discord-specific content

Some Discord features have no equivalent in Spectrum's cross-platform `Content`
model, so the provider exposes them as **Discord-scoped content** — helpers
imported from `@photon-ai/spectrum-ts/providers/discord` that never enter the
universal `Content` union.

### Embeds

`embed(...)` sends a single Discord message carrying up to 10
[`RichEmbed`s](https://discord.com/developers/docs/resources/message#embed-object)
plus optional leading text — together in one message (unlike `group`, which fans
out to one message per item).

```ts
import { attachment } from "@photon-ai/spectrum-ts";
import { discord, embed } from "@photon-ai/spectrum-ts/providers/discord";

// one embed
await discord(app).space.get(channelId).send(
  embed({
    title: "Release v2",
    description: "Changelog…",
    color: 0x5865f2,
    fields: [{ name: "Status", value: "Shipped" }],
    footer: { text: "photon" },
  })
);

// up to 10 embeds + leading text, in a single message
await discord(app).space.get(channelId).send(
  embed([cardA, cardB], { content: "see below 👇" })
);

// an embed rendering a locally uploaded image (file ships in the same request)
await discord(app).space.get(channelId).send(
  embed(
    { title: "Chart", image: { url: "attachment://chart.png" } },
    { files: [attachment("./chart.png")] }
  )
);

// an embed as a reply
await message.reply(embed({ title: "re: your message" }));
```

| Argument | Notes |
| --- | --- |
| `embeds` | A single `RichEmbed` or an array (1–10). Validated up front against [Discord's embed limits](https://discord.com/developers/docs/resources/message#embed-object-embed-limits) (title ≤256, description ≤4096, ≤25 fields, field value ≤1024, footer ≤2048, author ≤256, ≤6000 combined, 24-bit integer `color`) — an overflow throws with a precise message rather than 400ing at send. |
| `options.content` | Optional leading text rendered above the embeds in the same message. |
| `options.files` | `attachment(...)` builders uploaded with the message; reference one from an embed via `image`/`thumbnail`/`author.icon_url`/`footer.icon_url` as `attachment://<filename>`. A reference with no matching file throws at build. |

- **Outbound only.** Inbound messages do not surface embeds — auto-generated link
  previews and other bots' embeds are dropped.
- **Composable.** An embed may be sent on its own, combined with text via
  `options.content`, wrapped as `reply(embed(...))`, or included as an item of a
  `group(...)` — `buildSend` maps it in each case.
- **Maps to** `POST /channels/{id}/messages` with `{ content?, embeds }` (+ any
  `attachment://` files as multipart parts) via `embedToSpec` (`outbound/message.ts`);
  `buildSend` narrows it with the `isEmbed` guard and returns a record with the
  real message id.

> **Bot permission.** Sending embeds requires the bot to have the **Embed Links**
> permission in the target channel; without it Discord silently strips them.

### Interactive components

`components(...)` (`content/components.ts`) sends a single Discord message
carrying up to **5 action rows** of buttons and select menus, plus optional
leading text. A user clicking a button or submitting a select fires an inbound
[component interaction](#what-inbound-surfaces-v1).

```ts
import { discord, components, row, button, linkButton, select, ButtonStyle }
  from "@photon-ai/spectrum-ts/providers/discord";

// a row of buttons (each click emits an interaction carrying its customId)
await discord(app).space.get(channelId).send(
  components(
    row(
      button({ customId: "approve", label: "Approve", style: ButtonStyle.success }),
      button({ customId: "reject", label: "Reject", style: ButtonStyle.danger }),
      linkButton({ url: "https://example.com/docs", label: "Docs" })
    ),
    { content: "Review this change:" }
  )
);

// a select menu (must be the only component in its row)
await discord(app).space.get(channelId).send(
  components(
    row(select({
      customId: "pick",
      placeholder: "Choose one",
      options: [
        { label: "Alpha", value: "a" },
        { label: "Bravo", value: "b" },
      ],
    }))
  )
);
```

Ergonomic constructors build the SDK's wire shapes for you (the wire format uses
numeric `type`/`style` discriminators):

| Constructor | Builds |
| --- | --- |
| `button({ customId, label?, style?, emoji?, disabled? })` | a clickable button that emits an interaction carrying `customId` (default style `secondary`) |
| `linkButton({ url, label?, emoji?, disabled? })` | a link button (style 5) that opens `url` — emits **no** interaction and carries no `customId` |
| `select({ customId, options, placeholder?, minValues?, maxValues?, disabled? })` | a string select menu |
| `row(...children)` | wrap up to 5 buttons **or** a single select into one action row |
| `ButtonStyle` | `primary` / `secondary` / `success` / `danger` / `link` / `premium` |

Each returned value is exactly the `@photon-ai/discord-ts` request type, so an
advanced caller can hand-write the objects and pass them to `components()`
directly. The entity selects (user/role/mentionable/channel, types 5–8) have no
constructor yet — hand-write them.

- **Layout rules.** ≤5 rows; each row holds up to 5 buttons **or** exactly one
  select menu (the two never share a row). Discord's limits (`custom_id` ≤100,
  button label ≤80, select placeholder ≤150, 1–25 select options, option
  label/value/description ≤100) are validated **up front** by the schema — an
  overflow throws a precise message at construction rather than 400ing at send.
  Link buttons require a `url` and no `custom_id`; premium buttons require a
  `sku_id`; every other button needs a `custom_id`.
- **Composable.** May be sent on its own, with leading text via `options.content`,
  wrapped as `reply(components(...))`, or included as an item of `group(...)` —
  `buildSend` narrows it with the `isComponents` guard in each case.
- **Maps to** `POST /channels/{id}/messages` with `{ content?, components }` via
  `componentsToSpec` (`outbound/message.ts`).

---

## Mentions

Every outbound message carries an `allowed_mentions` object resolved by
`resolveAllowedMentions` (`outbound/send.ts`). Precedence:

1. An `allowed_mentions` the content already set (only `custom` can) wins verbatim.
2. Otherwise `config.allowedMentions`, with `replied_user` defaulted to `false`
   unless the config sets it explicitly.
3. Otherwise the safe default — `{ parse: ["users", "roles", "everyone"], replied_user: false }`: in-content `@mentions` ping exactly as Discord's
   implicit default, but a reply **never** pings the message it replies to.

So the provider's standing behavior is *replies don't ping the author* unless you
opt back in with `replied_user: true`. `config.allowedMentions` lets a bot govern
mentions globally — e.g. `{ parse: [] }` to mute every mention, or
`{ parse: ["users"] }` to allow only user mentions and suppress
`@everyone`/role pings.

`allowedMentions` mirrors [Discord's `allowed_mentions` object](https://discord.com/developers/docs/resources/message#allowed-mentions-object)
and is validated up front:

| Field | Notes |
| --- | --- |
| `parse` | Whitelist mention **types**: any of `"users"` / `"roles"` / `"everyone"`. |
| `users` | Whitelist specific user ids (numeric snowflakes, ≤100). Mutually exclusive with `parse: "users"` — setting both throws (Discord 400s). |
| `roles` | Whitelist specific role ids (numeric snowflakes, ≤100). Mutually exclusive with `parse: "roles"`. |
| `replied_user` | Whether a reply pings the author of the replied-to message. Provider default `false`. |

For a one-off override, send `custom` content carrying its own `allowed_mentions`
— it wins over both the config and the default.

---

## Threads, pins (instance actions)

Instance actions surface on the platform instance (`discord(app).<action>(…)`),
unlike space/message actions which dispatch through `send`. The provider exposes
four: two thread starts that return a thread id, and `pin`/`unpin` that resolve to
void.

### Threads

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

### Pins

`pin`/`unpin` (`outbound/pin.ts`) toggle a message's pinned state in its channel.
Both take a `Message` — the channel and message snowflakes come from it (the id
resolved through `parseMessageId`, so flattened group-item ids unwrap to the
underlying snowflake) — and resolve to void.

```ts
await discord(app).pin(message);
await discord(app).unpin(message);
```

- **`pin(message)`** → `PUT /channels/{channel}/messages/pins/{message}`. A
  channel holds at most **50** pins; pinning beyond that fails with a 400.
- **`unpin(message)`** → `DELETE /channels/{channel}/messages/pins/{message}`.
  Discord 404s if the message was never pinned.

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
| `allowedMentions` | no | Default `allowed_mentions` applied to every outbound message — restrict which mentions ping. See [Mentions](#mentions). Regardless of this, the provider defaults `replied_user` to `false`. |

---

## File map

| File | Responsibility |
| --- | --- |
| `index.ts` | `definePlatform` wiring (fusor mode) + `startThread`/`createThread`/`pin`/`unpin` actions; re-exports `embed`/`components` content |
| `config.ts` | config schema (incl. `allowedMentions`), `DISCORD_PLATFORM`, `DEFAULT_BASE_URL` |
| `verify.ts` | `verify(config)` — parse the relayed `{ t, d }` dispatch |
| `client.ts` | `discordClient` + REST helpers (`createChannelMessage`, `editChannelMessage`, `getChannelMessage`, `addReaction`, `triggerTyping`, `createDmChannel`, thread starts, `pinMessage`/`unpinMessage`, `acknowledgeComponentInteraction`) |
| `types.ts` | Gateway dispatch types (incl. `Interaction`/`InteractionType`), DTO shapes, `DiscordPayload` |
| `space.ts` | user resolution + `space.create` (DM open; existing channels via `space.get(id)`) |
| `content/embed.ts` | Discord-scoped `embed(...)` content (`embed`/`asEmbed`/`isEmbed`, `__platform: "discord"`) |
| `content/components.ts` | Discord-scoped `components(...)` content + `row`/`button`/`linkButton`/`select`/`ButtonStyle` constructors and limit validation |
| `util.ts` | `FormData` serialization for multipart uploads, attachment download |
| `inbound/messages.ts` | `handleMessages` — dispatch → record (incl. component interactions) |
| `inbound/poll.ts` | poll reconstruction + answer-id → option lookup |
| `inbound/media.ts` | attachment → content mapping |
| `outbound/message.ts` | `buildSend` — content → `DiscordSendSpec` (pure); `embedToSpec`/`componentsToSpec`; `parseMessageId` |
| `outbound/send.ts` | dispatcher; builds the client inline; `resolveAllowedMentions` |
| `outbound/thread.ts` | `startThread` / `createThread` + options |
| `outbound/pin.ts` | `pin` / `unpin` instance actions |

---

## Testing

Tests live under `test/providers/discord/`. The seam is `globalThis.fetch`:
because `send` and the poll-vote path build the REST client inline from `config`
(which has no `fetch` field), there is no client to inject — a per-test
`spyOn(globalThis, "fetch")` intercepts the real request path.

- `inbound/messages.test.ts` — dispatch → record mapping for all event kinds
  (messages, attachments/groups, polls, edits, deletes, reactions and removals,
  poll votes, component interactions), including self-echo drop, the poll-vote
  fetch/cache path, and the interaction ack-before-surface path.
- `outbound/message.test.ts` — pure `buildSend` content→spec mapping (polls,
  files, replies) and `parseMessageId` cases.
- `outbound/embed.test.ts` — Discord-scoped `embed`: builder/`asEmbed`/`isEmbed`,
  the 1–10 bounds, and `embedToSpec` (content + embeds → one message body).
- `outbound/components.test.ts` — Discord-scoped `components`: the
  `row`/`button`/`linkButton`/`select` constructors, layout/limit validation, and
  `componentsToSpec` (content + components → one message body).
- `outbound/allowed-mentions.test.ts` — `resolveAllowedMentions` precedence
  (content override > config > safe default) and the `replied_user: false` default.
- `outbound/thread.test.ts` — `startThread`/`createThread` request bodies and
  options (auto-archive, slow-mode, private/invitable).
- `outbound/pin.test.ts` — `pin`/`unpin` request paths and message-id unwrapping.
