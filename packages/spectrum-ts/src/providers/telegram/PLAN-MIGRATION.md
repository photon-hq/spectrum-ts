# Telegram Provider Migration

The Telegram provider was rewritten as a thin adapter over the
`@photon-ai/telegram` gRPC SDK (sibling repo: `photon-hq/spectrum-telegram`).
The previous implementation talked to `api.telegram.org` directly via long
polling, kept its own LRU cache for albums and polls, and shipped a
hand-written Bot API spec generator. None of that lives here anymore — the
hosted Spectrum Telegram transport (a Hono webhook receiver + nice-grpc
fan-out server, with Postgres-backed durable replay) owns it.

This doc captures the deferred work and the deltas a consumer may notice.

## Architecture

```
+----------------+        +-----------------------------+        +-------------+
|  Your app      |  gRPC  |  spectrum-telegram          |  HTTPS |  Telegram   |
|  spectrum-ts   <------->+  (gRPC + Hono webhook)      <-------->  Bot API    |
|  Telegram      |        |  Postgres event_log + bots  |        |             |
|  provider      |        +-----------------------------+        +-------------+
+----------------+
```

The in-tree provider is now:

- `types.ts` — direct vs cloud config union, space/user/message schemas.
- `auth.ts` — cloud-mode token rotation + resubscribable streams.
- `messages.ts` — `TelegramEvent` ↔ Spectrum `Content` / `Message` mapper.
- `index.ts` — `definePlatform("Telegram", { ... })`.

## Deferred follow-ups

### 1. `ResolveChat` RPC for rich `space()` resolution

The SDK doesn't yet expose a chat-metadata lookup. `space.resolve` currently
returns only `{ id: chatId }`; the old in-tree provider used to call
`getChat` to populate `type`, `title`, `username`. The proto needs:

```proto
service Bot {
  // ...
  rpc ResolveChat(ResolveChatRequest) returns (ResolveChatResponse);
}

message ResolveChatRequest { string chat_id = 1; }
message ResolveChatResponse {
  string id = 1;
  string type = 2;             // "private" | "group" | "supergroup" | "channel"
  optional string title = 3;
  optional string username = 4;
}
```

Server implementation is a thin proxy to Telegram's `getChat`. SDK exposes
`client.spaces.resolve(chatId)`. When that lands, restore the richer
`spaceSchema`:

```ts
export const spaceSchema = z.object({
  id: z.string(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  username: z.string().optional(),
});
```

…and have `space.resolve` call the new RPC.

### 2. Multi-bot per Spectrum instance

Cloud mode already returns `TelegramClient[]` and the inbound stream is
multiplexed via `mergeStreams`. Outbound `send` picks `clients[0]` as the
primary bot. When multi-bot send becomes a requirement, extend
`spaceSchema` with `bot?: string` and route by that in `messages.ts`'s
`primary(...)` helper.

### 3. Lost surface area from the old in-tree provider

These features existed before the swap and are not yet wired through the
SDK. Most have natural homes; none are blocking.

| Feature | Where it goes |
|---|---|
| Per-user `apiBaseUrl` (self-hosted `tdlib/telegram-bot-api`) | SDK already accepts `endpoint`; map a config field if/when needed. |
| `pollingTimeout` / `dropPendingUpdates` | Polling is gone; the hosted transport uses webhooks. Cursor checkpointing handles missed-update replay. |
| In-process album coalescing + LRU cache | Hosted transport persists albums in `event_log`; `mediaGroupId` is surfaced on each `InboundMessage` and apps can correlate themselves. |
| `bot-api-spec/` generator + `generated/{methods,types}` | Gone. SDK exposes a typed surface; raw Bot API params still go through `params: Record<string, string>`. |
| `getMessage` action | Not yet wired. Add by caching inbound messages in `messages.ts` (small LRU keyed by `space.id + messageId`) and exposing via `actions.getMessage`. |

### 4. Forum topics, business connection update plumbing

The SDK proto already supports `messageThreadId` on `sendChatAction` and
`MarkBusinessRead` for Business accounts. The Spectrum-side adapter does
not yet surface them — add `space.params.threadId` and a
`telegram.business({ businessConnectionId })` action when these come up.

## Removed dependencies

- `quick-lru` — local cache, no longer needed (SDK + hosted transport own
  state).
- `gen:telegram` script + `bot-api-spec/` — superseded by the SDK's
  generated proto types.

## Notes on cloud mode

`utils/cloud.ts` gained `issueTelegramTokens(projectId, projectSecret)`
returning `{ auth: Record<botId, botToken>, endpoint?, expiresIn }`. The
spectrum.photon.codes cloud needs to expose a `POST
/projects/{id}/telegram/tokens` endpoint that returns this shape. The
hosted transport then validates `bot_token` on every gRPC call as today.
