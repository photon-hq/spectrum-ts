# Telegram Bot API Spec

JSON schema of the Telegram Bot API subset used by the Telegram provider, plus the generator that emits `providers/telegram/generated/*.ts`.

## Layout

```text
packages/spectrum-ts/src/providers/telegram/bot-api-spec/
├── schema/
│   └── telegram.json
├── generators/
│   └── typescript.ts
└── README.md
```

## Scope

The schema covers the Bot API surface that maps onto Spectrum's `Platform`:

- `send` — `text`, `richlink`, `attachment`, `voice`, `contact`, `poll`, `reply`, `edit`, `reaction`, `typing`, `group`
- `messages` — long-polling stream of inbound `Update`s
- Lifecycle: `getMe`, `getChat`, `getFile`

Notes on a few non-obvious mappings:

- `typing` with `state: "stop"` is a no-op. `sendChatAction` is one-shot and the indicator auto-expires after ~5s; there's no cancel endpoint.
- `Update.poll_answer` is diffed against the bot's prior cached vote vector and emitted as per-option `poll_option` events. `sendPoll` always pins `is_anonymous: false` to enable this. `Update.poll` aggregate state is unmapped.
- Outbound `richlink` drops `title` / `summary` / `cover` — Telegram's preview scraper owns that metadata; the Bot API exposes only layout knobs.

### Provider-local cache

Bridges the gaps in the Bot API (no fetch-by-id, no album update kind, no chat on `poll_answer`):

- **Messages cache** — bounded LRU written by every inbound `Update.message` and outbound send. `space.getMessage(id)` reads from it. Reaction events also use it to hydrate `reaction.target`.
- **Poll cache** — maps `poll_id` to the original Spectrum poll + chat snapshot, plus per-voter vote vectors for diffing.
- **Album buffer** — with `coalesceAlbums: true`, debounces members sharing `media_group_id` into a single `group`; off by default.

In-process, capacity-bounded, no TTL, torn down with the runtime. Defaults: 5000 messages, 500 polls, 5000 vote vectors, 100 concurrent albums, 500ms debounce, 2s ceiling. Set any capacity to `0` to disable that slot.

Inline queries, callback queries, payments, passports, forum topics, and admin operations are out of scope; surface them via custom events if needed.

## Schema format

TypeRef DSL:

- Primitives: `string`, `integer`, `float`, `boolean`, `any`
- Reference: `Ref:<TypeName>`
- Composition: `Array:<Inner>`, `Union:<A>|<B>|...`

`InputFile` is a marker; the generator emits `string | Blob`.

### Type

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

Field options: `required`, `description`, `enum`, `const`.

### Method

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

## Regeneration

```bash
bun run gen:telegram
```

Rewrites `providers/telegram/generated/*.ts`. Generated files are committed; CI runs `git diff --exit-code` after regen.

## Adding a method

1. Add any new type under `types`.
2. Add the method under `methods` with params and return type.
3. `bun run gen:telegram`.
4. Commit schema + generated output together.

## Version

Tracking **Bot API 9.6** (April 3, 2026).
