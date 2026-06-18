// Live Gemini chatbot, streamed token-by-token into Discord, with short
// per-conversation memory. `streamText().textStream` → `markdown()` → Spectrum
// edits the message in place as deltas land. Swap `google(...)` for
// `anthropic(...)`/`openai(...)` and nothing else changes.
//
// Needs GOOGLE_GENERATIVE_AI_API_KEY (read by @ai-sdk/google).
// Run: bun ai  (then @-mention or DM the bot)

import { google } from "@ai-sdk/google";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { type ModelMessage, streamText } from "ai";
import { markdown, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

const MODEL = "gemini-2.5-flash";
const SYSTEM =
  "You are a friendly, concise assistant living in a Discord server. " +
  "Keep replies short and conversational, and use light Markdown when it helps.";
const HISTORY_LIMIT = 20;

// One chat history per Spectrum space (one conversation = one space.id).
const histories = new Map<string, ModelMessage[]>();

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
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
  await space.send(markdown(result.textStream));

  history.push({ role: "assistant", content: await result.text });
  histories.set(space.id, history.slice(-HISTORY_LIMIT));
}
