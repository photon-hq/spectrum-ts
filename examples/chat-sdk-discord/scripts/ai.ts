// A live Gemini chatbot, streamed token-by-token into Discord.
//
// This is `streaming.ts` with a real brain: instead of a fake token generator,
// it calls Gemini through the Vercel **AI SDK** (`ai` + `@ai-sdk/google`) and
// hands the resulting `textStream` straight to Spectrum. Spectrum's `markdown()`
// accepts any `AsyncIterable<string>`, and the Discord adapter edits the message
// in place as deltas arrive — so the reply fills in word by word, natively.
//
// (The provider is the only Gemini-specific line — swap `google(...)` for
// `anthropic(...)`/`openai(...)` and the rest of this file is unchanged.)
//
// It also keeps a short per-conversation history (keyed by `space.id`), so the
// bot remembers earlier turns in the same channel/DM.
//
// Needs, in addition to the usual Discord env (see bot.ts):
//   GOOGLE_GENERATIVE_AI_API_KEY   — read automatically by @ai-sdk/google (Bun loads `.env`)
//
// Run: bun ai   (then @-mention or DM the bot)

import { google } from "@ai-sdk/google";
import { type ModelMessage, streamText } from "ai";
import { markdown, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

// Swap for "gemini-2.5-pro" if you want a more capable (slower) model.
const MODEL = "gemini-2.5-flash";
const SYSTEM =
  "You are a friendly, concise assistant living in a Discord server. " +
  "Keep replies short and conversational, and use light Markdown when it helps.";

// How many turns of history to keep per conversation (user + assistant entries).
const HISTORY_LIMIT = 20;

// In-memory chat history per Spectrum space (one conversation = one space.id).
const histories = new Map<string, ModelMessage[]>();

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  const history = histories.get(space.id) ?? [];
  history.push({ role: "user", content: message.content.text });

  const result = streamText({
    model: google(MODEL),
    system: SYSTEM,
    messages: history,
  });

  // Spectrum streams the deltas into Discord, editing the message as they land.
  await space.send(markdown(result.textStream));

  // Once the stream drains, record the full reply so the next turn has context.
  history.push({ role: "assistant", content: await result.text });
  histories.set(space.id, history.slice(-HISTORY_LIMIT));
}
