// One AI brain, two platforms — a streaming Gemini chatbot answering on Discord
// AND in Linear issue comments from a single loop. The AI path is platform-
// agnostic; the only platform-aware touch is the persona, picked with
// `linear.is(message)`. Swap `google(...)` for `anthropic(...)`/`openai(...)`.
//
// Needs GOOGLE_GENERATIVE_AI_API_KEY (plus the Discord + Linear env, see README).
// Linear arrives over the webhook served below; Discord over the Gateway (auto).
//
// Run: bun ai

import { google } from "@ai-sdk/google";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createLinearAdapter } from "@chat-adapter/linear";
import { type ModelMessage, streamText } from "ai";
import { markdown, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

const MODEL = "gemini-2.5-flash";
const DISCORD_SYSTEM =
  "You are a friendly, concise assistant living in a Discord server. " +
  "Keep replies short and conversational, and use light Markdown when it helps.";
const LINEAR_SYSTEM =
  "You are a concise engineering assistant replying inside a Linear issue. " +
  "Help triage and move the issue forward: summarize, suggest next steps, and " +
  "ask only the questions you need. Use Markdown sparingly.";
const HISTORY_LIMIT = 20;

// One chat history per Spectrum space; the key is already platform-scoped.
const histories = new Map<string, ModelMessage[]>();

const discord = chatSDK(createDiscordAdapter());
const linear = chatSDK(createLinearAdapter());

const app = await Spectrum({
  providers: [
    discord.config({ userName: "spectrum-bot" }),
    linear.config({ userName: "spectrum-bot" }),
  ],
});

// Serve the Linear webhook ourselves — Discord arrives over the Gateway (auto).
Bun.serve({
  port: 3000,
  routes: { "/webhooks/linear": { POST: linear(app).webhook } },
});
console.log("listening for Linear webhooks on :3000/webhooks/linear");

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  // Pick the persona by narrowing — no `space.id` prefix sniffing.
  const system = linear.is(message) ? LINEAR_SYSTEM : DISCORD_SYSTEM;

  const history = histories.get(space.id) ?? [];
  history.push({ role: "user", content: message.content.text });

  const result = streamText({
    model: google(MODEL),
    system,
    messages: history,
  });
  await space.send(markdown(result.textStream));

  history.push({ role: "assistant", content: await result.text });
  histories.set(space.id, history.slice(-HISTORY_LIMIT));
}
