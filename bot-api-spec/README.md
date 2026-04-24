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

- `send` (text, media, contact, voice)
- `replyToMessage`, `editMessage`
- `reactToMessage`, `startTyping`
- `events.messages` (via long polling)
- Lifecycle sanity checks (`getMe`, `getChat`, `getFile`)

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

Currently tracking **Bot API 9.6** (April 3, 2026). The subset has been reviewed against the 8.3 → 9.6 changelog; none of the in-scope types (`Update`, `Message`, `User`, `Chat`, `Audio`, `Video`, `Voice`, `Document`, `PhotoSize`, `Contact`, `MessageEntity`, `LinkPreviewOptions`, `MessageReactionUpdated`, `ReactionType`, `ReplyParameters`, `ResponseParameters`, `File`, `InputFile`) or methods (`getMe`, `getUpdates`, `sendMessage`, `sendPhoto`, `sendVideo`, `sendAudio`, `sendVoice`, `sendDocument`, `sendContact`, `sendChatAction`, `editMessageText`, `setMessageReaction`, `getChat`, `getFile`) had breaking changes across that span. Features introduced between 8.4 and 9.6 (managed bots, checklists, suggested posts, stories, gifts, polls, mini-app storage, direct-message topics, paid posts) are intentionally out of the universal scope.
