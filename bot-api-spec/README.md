# Telegram Bot API Spec

Single source of truth for the Telegram Bot API surface that Spectrum exposes across all language ports (`spectrum-ts`, `spectrum-go`, `spectrum-py`, `spectrum-swift`, …).

This directory is **not** a package. It is a plain folder in the `spectrum-ts` repo. Other language repos consume it via git submodule or manual sync.

## Layout

```text
bot-api-spec/
├── schema/
│   └── telegram.json       ← authoritative schema (hand-written)
├── generators/
│   └── typescript.ts       ← emits TS types + method map into spectrum-ts
└── README.md
```

## Scope

The schema covers only the Bot API subset that maps onto Spectrum's universal `Platform` actions:

- `send` (text, media, contact, voice, poll)
- `replyToMessage`, `editMessage`
- `reactToMessage`, `startTyping`
- `events.messages` (via long polling)
- Lifecycle sanity checks (`getMe`, `getChat`, `getFile`)

Inbound `Update.poll_answer` is mapped to Spectrum's universal `poll_option` events using a per-runtime in-process cache populated when the bot sends a poll via `sendPoll` (which always pins `is_anonymous: false`). Each `poll_answer` is diffed against the user's previously cached vote vector to produce the `selected: true` / `selected: false` events Spectrum's `poll_option` schema expects, matching the contract iMessage and WhatsApp Business already implement under PR #35. Vote events therefore surface only for polls a bot owns; polls sent by other clients in a chat continue to be observable as `poll` content (the body) but produce no per-vote events. `Update.poll` (aggregate vote totals / closure state) is still **not** mapped — Spectrum has no "poll snapshot" content type and translating "poll closed" into per-user diffs would require keeping every prior vote vector for every poll, a sharper memory cost than the bounded per-user state used for `poll_answer` resolution.

Outbound `richlink` content drops `Richlink.title` / `Richlink.summary` / `Richlink.cover` on Telegram. Telegram preview cards are produced by a server-side scraper that fetches the URL and parses Open Graph / Twitter Card / oEmbed metadata; `sendMessage` exposes only layout knobs (size, position, on/off) via `LinkPreviewOptions`, with no input fields for caller-supplied title, description, or image. The richlink is sent as the URL with `prefer_large_media` pinned, so Telegram still renders a big preview card — but the metadata comes from the destination, not the caller. Cross-platform fan-out (e.g. iMessage + Telegram) will therefore show the caller's title on iMessage and the scraped title on Telegram.

### Provider-local cache

Telegram's Bot API has no general "fetch message by id" endpoint, no "album" update kind, and no chat-id on `poll_answer`, so the provider keeps a small in-process cache to bridge the universal Spectrum contract:

- **Messages cache** — every inbound `Update.message` (and every outbound `send` / `replyToMessage` / `editMessage` receipt) is written through a bounded LRU. `space.getMessage(id)` returns hot entries; cold ids return `undefined` (matching iMessage local-mode semantics). `Update.message_reaction` events also use this cache to hydrate `reaction.target` into the real prior `Message` when available, falling back to a `custom`-content stub when not.
- **Poll cache** — `sendPoll` records `(poll_id → original Spectrum poll, chat snapshot, message id)` and per-`(poll_id, user_id)` vote vectors so `poll_answer` updates can be diffed into `poll_option` events.
- **Album buffer** — when `coalesceAlbums: true`, members of an album (messages sharing `media_group_id`) are debounced and emitted as a single `group` content; when off (the default), each album member surfaces individually with a `mediaGroupId` extra so callers can group themselves.

The cache is bounded by capacity (no TTL — a cached message doesn't go stale in any meaningful way; attachment URLs are re-resolved lazily through `getFile` on every read), in-process only, never persisted, and torn down with the runtime. Defaults: 5000 messages, 500 polls, 5000 vote vectors, 100 concurrent in-flight albums; album debounce 500 ms with a 2 s ceiling. Set any capacity to `0` to disable that slot — `cache: { messages: 0 }` restores the pre-cache "always undefined" `getMessage` behaviour, `cache: { polls: 0 }` skips `poll_answer` resolution, etc.

Features outside this universal set (inline queries, callback queries, payments, passports, forum topics, admin operations, etc.) are **intentionally excluded**. They are surfaced — when needed — as provider-specific custom events, not via this schema.

## Schema format

Language-neutral JSON. The TypeRef DSL has three shapes:

- **Primitives**: `string`, `integer`, `float`, `boolean`, `any`
- **Reference**: `Ref:<TypeName>` (e.g. `Ref:Message`)
- **Composition**: `Array:<Inner>`, `Union:<A>|<B>|...` (members may themselves be primitives or `Ref:X`)

Special primitive: `InputFile` is a type marker, not a concrete shape. Each language generator maps it to its own file-upload abstraction (TS: `string | Blob`; Go: `io.Reader | string`; Python: `bytes | str | BinaryIO`; Swift: `Data | String`).

### Type definition

```json
"Message": {
  "description": "A message.",
  "fields": [
    { "name": "message_id", "type": "integer", "required": true },
    { "name": "text", "type": "string", "required": false },
    { "name": "chat", "type": "Ref:Chat", "required": true }
  ]
}
```

Field options:

- `required` (boolean)
- `description` (string, emitted as docstring)
- `enum` (string array, emits a string literal union)
- `const` (string, emits a literal type)

### Method definition

```json
"sendMessage": {
  "description": "Sends a text message.",
  "httpMethod": "POST",
  "params": [
    { "name": "chat_id", "type": "Union:integer|string", "required": true },
    { "name": "text", "type": "string", "required": true }
  ],
  "returns": "Ref:Message"
}
```

`returns` uses the same TypeRef DSL as fields.

## Regeneration

After editing `schema/telegram.json`:

```bash
bun run gen:telegram
```

This rewrites `packages/spectrum-ts/src/providers/telegram/generated/*.ts`.

Generated files are committed to git. CI should verify `git diff --exit-code` after regeneration to prevent hand-edits from drifting.

## Adding a method

1. If the method introduces a new type, add it under `types`.
2. Add the method under `methods` with full param list and return type.
3. Run `bun run gen:telegram`.
4. Commit schema + generated output together.

When other language repos are in scope, they must pick up the updated schema and regenerate their own output before the change is considered complete.

## Adding a new language generator

Each language port owns its own generator, in its own repo. A generator must:

1. Read `bot-api-spec/schema/telegram.json`.
2. Emit types and a method map into the target language.
3. Map `InputFile` to that language's file/upload abstraction.
4. Honor required/optional semantics natively (omitempty / Optional / nullable).
5. Commit generated output.

The `generators/typescript.ts` in this repo is the reference implementation. It is intentionally simple (~200 lines) so new language generators can follow the same shape.

## Versioning

The schema's `version` field tracks the Telegram Bot API version the subset was written against. Bumping `version` without reviewing the Bot API changelog is discouraged — new features in Telegram may require schema additions, not just a version bump.

Currently tracking **Bot API 9.6** (April 3, 2026). The subset has been reviewed against the 8.3 → 9.6 changelog; none of the in-scope types (`Update`, `Message`, `User`, `Chat`, `Audio`, `Video`, `Voice`, `Document`, `PhotoSize`, `Contact`, `MessageEntity`, `LinkPreviewOptions`, `MessageReactionUpdated`, `ReactionType`, `Poll`, `PollOption`, `InputPollOption`, `PollAnswer`, `ReplyParameters`, `ResponseParameters`, `File`, `InputFile`) or methods (`getMe`, `getUpdates`, `sendMessage`, `sendPhoto`, `sendVideo`, `sendAudio`, `sendVoice`, `sendDocument`, `sendContact`, `sendPoll`, `stopPoll`, `sendChatAction`, `editMessageText`, `setMessageReaction`, `getChat`, `getFile`) had breaking changes across that span. Features introduced between 8.4 and 9.6 (managed bots, checklists, suggested posts, stories, gifts, mini-app storage, direct-message topics, paid posts) are intentionally out of the universal scope. Poll types are kept in scope because outbound `sendPoll` is a first-class action, but inbound `poll` / `poll_answer` updates are exposed only via the raw client.
