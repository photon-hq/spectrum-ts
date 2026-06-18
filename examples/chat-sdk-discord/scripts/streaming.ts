// Streamed reply, token-by-token. `text()`/`markdown()` accept any
// `AsyncIterable<string>` (an AI SDK `streamText().textStream`, an LLM stream, or
// a plain generator); the Discord adapter edits the message as deltas arrive.
//
// Run: bun streaming  (then @-mention or DM the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { markdown, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

// Stand-in for an LLM token stream — swap for `streamText({...}).textStream`.
async function* fakeTokens(prompt: string): AsyncGenerator<string> {
  const reply = `Here's a streamed reply to "${prompt}". Watch it fill in word by word…`;
  for (const word of reply.split(" ")) {
    yield `${word} `;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(markdown(fakeTokens(message.content.text)));
  }
}
