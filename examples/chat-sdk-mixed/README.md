# Spectrum × Chat SDK — Discord + Linear (mixed)

One bot, **two** Vercel **chat SDK** adapters — `@chat-adapter/discord` and
`@chat-adapter/linear` — driven through a single **Spectrum** loop
(`spectrum-ts/providers/chat-sdk`). The headline `scripts/ai.ts` is a streaming
Gemini chatbot that answers on Discord **and** in Linear issue comments from the
same `app.messages` loop.

## The big idea

Each adapter is its **own narrowable Spectrum platform** — `chatSDK(adapter)`
infers the platform name from the adapter's own `name` ("discord" / "linear"),
exactly like the native `imessage` / `telegram` providers. You list them in
`providers` like any other platform; Spectrum merges their inbound messages into
a single stream, so the agnostic loop never branches on platform — `space.send(...)`
routes the reply back to wherever the message came from. When you DO want
platform-specific behavior, narrow type-safely (`linear.is(message)`,
`discord(app).messages`) — see `scripts/narrowed.ts`. The only thing that
differs per platform is **delivery**:

- **Discord** → messages arrive over the **Gateway**, opened automatically by
  the provider. No HTTP server needed.
- **Linear** → events arrive over **webhooks**, so you serve `linear(app).webhook`
  yourself (a tiny `Bun.serve` route, shown in the scripts).

## Setup (once)

1. **Create a Discord app** at <https://discord.com/developers/applications>:
   - **Bot** tab → copy the **token**, and turn **ON** _Message Content Intent_.
   - **General Information** → copy the **Public Key** and **Application ID**.
   - **Invite** the bot to a server: OAuth2 → URL Generator → scopes `bot` +
     `applications.commands`.
2. **Set up Linear**:
   - **Personal API key** — [Settings → Security & Access](https://linear.app/settings/account/security)
     → create a key with _Create comments_ permission → `LINEAR_API_KEY`.
   - **Webhook** — Settings → API → Webhooks → create one pointing at your public
     URL (`https://<tunnel>/webhooks/linear`), subscribe to **Comments** (and
     **Agent session events** if you run an app-actor install), and copy the
     **signing secret** → `LINEAR_WEBHOOK_SECRET`.
   - `LINEAR_BOT_USERNAME` is the @mention that triggers the bot in issue comments.
3. **Env** — copy `.env.example` to `.env` and fill it in (Bun auto-loads it):
   ```
   DISCORD_BOT_TOKEN=...
   DISCORD_APPLICATION_ID=...
   DISCORD_PUBLIC_KEY=...
   LINEAR_API_KEY=...
   LINEAR_WEBHOOK_SECRET=...
   LINEAR_BOT_USERNAME=spectrum-bot
   ```
   The `ai.ts` Gemini chatbot also needs `GOOGLE_GENERATIVE_AI_API_KEY=...`.
4. **Install:** `bun install` (from the repo root).
5. **Expose the Linear webhook** — both scripts serve `:3000`. Tunnel it
   (`ngrok http 3000`) and register the public URL as your Linear webhook
   (`https://<tunnel>/webhooks/linear`). Discord needs no tunnel for plain
   messages (Gateway).

## The scripts

All scripts live in `scripts/`. Each lists one `chatSDK(adapter).config()`
provider per platform.

| Script | What it shows | Run |
| --- | --- | --- |
| `scripts/index.ts` | Baseline text echo across Discord **and** Linear from one loop | `bun echo` |
| `scripts/ai.ts` | Streaming Gemini chatbot (per-conversation memory) on both platforms, picking the persona with `linear.is(message)` | `bun ai` |
| `scripts/narrowed.ts` | Annotated tour of the narrowing styles (`is()` guards, per-platform streams) | `bun narrowed` |

(`bun <name>` runs the matching `package.json` script, from the example root so
`.env` is picked up.)

## Mental model

- **One platform per adapter** — `chatSDK(adapter)` is a narrowable platform
  named after the adapter; list them in `providers` and Spectrum merges their
  messages. `ai.ts` picks its persona with the `linear.is(message)` guard.
- **Spectrum is the handler** — the adapter is driven **headless** (no
  `onNewMention` etc.), or you'll double-reply.
- **Gateway vs webhook** — the provider auto-pumps Gateway adapters (Discord).
  Anything webhook-delivered (Linear) you serve yourself via `linear(app).webhook`.
- **Streaming is uniform** — `markdown(result.textStream)` works on both;
  Spectrum edits in place where the adapter supports it and posts the finished
  text where it doesn't.

## Gotchas

- **Discord Message Content Intent** must be ON or gateway messages arrive with
  empty text.
- **Linear comments** only reach the loop once the webhook is registered and
  reachable — if nothing happens, check the tunnel and the signing secret.
