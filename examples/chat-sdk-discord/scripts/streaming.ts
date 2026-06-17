// Streaming a reply token-by-token.
//
// Spectrum's `text()`/`markdown()` accept any `AsyncIterable<string>` (an AI
// SDK `streamText()` result, an OpenAI/Anthropic stream, or a plain generator).
// The Discord adapter streams it natively (editing the message as deltas
// arrive) or falls back to post-then-edit.
//
// Run: bun run streaming.ts  (then @-mention or DM the bot)

import { markdown, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

// Stand-in for an LLM token stream — swap for `streamText({...}).textStream`.
async function* fakeTokens(prompt: string): AsyncGenerator<string> {
  const reply = `Here's a streamed reply to "${prompt}". Watch it fill in word by word…`;
  for (const word of reply.split(" ")) {
    yield `${word} `;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }
  await space.send(markdown(fakeTokens(message.content.text)));
}
