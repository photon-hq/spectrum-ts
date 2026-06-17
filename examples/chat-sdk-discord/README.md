# Spectrum × Chat SDK — Discord examples

Runnable scripts showing a Vercel **chat SDK** Discord bot driven entirely
through **Spectrum's** messaging API (`spectrum-ts/providers/chat-sdk`). Each
file is standalone — pick one and run it.

## Setup (once)

1. **Create a Discord app** at <https://discord.com/developers/applications>:
   - **Bot** tab → copy the **token**, and turn **ON** _Message Content Intent_
     (and _Server Members Intent_ if you'll run `native-discord-roles`).
   - **General Information** → copy the **Public Key** and **Application ID**.
2. **Env** — copy `.env.example` to `.env` and fill it in (Bun auto-loads it):
   ```
   DISCORD_BOT_TOKEN=...
   DISCORD_APPLICATION_ID=...
   DISCORD_PUBLIC_KEY=...
   ```
   The `ai.ts` Gemini chatbot also needs `GOOGLE_GENERATIVE_AI_API_KEY=...`.
3. **Invite the bot** to a server: OAuth2 → URL Generator → scopes `bot` +
   `applications.commands`.
4. **Install:** `bun install` (from the repo root).
5. **Interactions endpoint** (only needed for slash commands / buttons):
   `slash-commands.ts` serves the webhook itself on `:3000` (the provider no
   longer binds a port — you own the HTTP server). Expose it with a tunnel
   (`ngrok http 3000`) and set the public URL at General Information →
   _Interactions Endpoint URL_ → `https://<tunnel>/webhooks/discord`. Regular
   messages arrive over the Gateway (opened automatically), so plain message
   bots don't need a server or a tunnel.

## The scripts

All scripts live in `scripts/`; the shared headless-bot factory is
`scripts/bot.ts`.

| Script | What it shows | Run |
| --- | --- | --- |
| `scripts/index.ts` | Baseline text echo | `bun echo` |
| `scripts/inspect.ts` | Dump every inbound event — text, files, voice, richlinks, reactions (add/remove), and the `custom` fallback for stickers/polls/embeds | `bun inspect` |
| `scripts/inspect-chatsdk.ts` | Same dump but on the **raw chat SDK** (no Spectrum) — shows the SDK's own `Message` (`text`/`attachments`/`formatted`/`raw`) and reaction events, so you can see where data is/isn't | `bun inspect-chatsdk` |
| `scripts/reply-and-react.ts` | Threaded reply + reaction + typing | `bun reply-and-react` |
| `scripts/embed.ts` | Discord embed via `custom({ card })` passthrough | `bun embed` |
| `scripts/ephemeral.ts` | Only-you-see-it message via `chatThread(space)` | `bun ephemeral` |
| `scripts/enrichment.ts` | `messageMeta` — mention / edited / link previews | `bun enrichment` |
| `scripts/attachments.ts` | Receive a file + send one back | `bun attachments` |
| `scripts/streaming.ts` | Token-by-token streamed reply | `bun streaming` |
| `scripts/ai.ts` | Live Gemini chatbot (with memory) streamed token-by-token via the Vercel AI SDK — needs `GOOGLE_GENERATIVE_AI_API_KEY` | `bun ai` |
| `scripts/slash-commands.ts` | `/`-command handled on the bot + `getBot(app)` | `bun slash-commands` |
| `scripts/native-discord-roles.ts` | Own `discord.js` client + role grant (tier 4) | `bun native-roles` |

(`bun <name>` runs the matching `package.json` script, from the example root so
`.env` is picked up.)

## Mental model

- **Conversational stuff** (text, embeds, buttons, reactions, ephemeral, modals,
  files, streaming) → done through Spectrum / the chat SDK. No raw Discord
  needed.
- **Server/platform stuff** (roles, channels, members, voice) → the chat SDK
  doesn't model it and hides its client, so run your **own** `discord.js` client
  with the same token (`native-discord-roles.ts`) and use the `space.id` decode
  (`discord:{guildId}:{channelId}:{threadId}`) to target the right place.
- The bot must stay **headless** (no message handlers) — Spectrum is the
  handler. Interaction handlers (`onSlashCommand`/`onAction`) are the exception:
  they're fine on the bot and coexist with the Spectrum loop.

## Discord gotchas

- **Message Content Intent** must be ON or gateway messages arrive with empty
  text.
