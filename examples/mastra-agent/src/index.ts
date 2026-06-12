// Mastra agent with tool calling, bridged to spectrum-ts.
//
// A Mastra `Agent` (Claude via the AI SDK Anthropic provider) answers chat
// messages and can call two tools: live weather (Open-Meteo, no API key
// needed) and the current time in a timezone. The agent's streaming response
// is handed straight to `text()` — platforms with native streaming (iMessage,
// Telegram) render it live; the terminal provider waits for the stream and
// delivers the accumulated text as one message.
//
// Run with: ANTHROPIC_API_KEY=sk-... bun run start

import { Spectrum, text } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";
import { assistant } from "./agents/assistant";

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "ANTHROPIC_API_KEY is required — the agent calls Claude through the AI SDK Anthropic provider."
  );
}

// How many model ↔ tool round-trips the agent may take per reply.
const MAX_TOOL_STEPS = 5;

// Discriminated by role so entries match Mastra's model-message union.
type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

const app = await Spectrum({ providers: [terminal.config()] });

const greeted = new Set<string>();
// Per-space transcript so follow-ups ("and tomorrow?") keep their context.
// For real persistence (threads, recall, storage) reach for @mastra/memory.
const histories = new Map<string, ChatMessage[]>();

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  if (!greeted.has(space.id)) {
    greeted.add(space.id);
    await space.send(
      text('hi! ask me anything — try "what\'s the weather in tokyo?"')
    );
  }

  const history = histories.get(space.id) ?? [];
  histories.set(space.id, history);
  history.push({ role: "user", content: message.content.text });

  await space.startTyping();
  try {
    const stream = await assistant.stream(history, {
      maxSteps: MAX_TOOL_STEPS,
    });
    // `text()` accepts the Mastra stream as-is (its `.textStream` is picked
    // up automatically); `send` resolves once the reply is fully delivered.
    const sent = await space.send(text(stream));
    if (sent?.content.type === "text") {
      history.push({ role: "assistant", content: sent.content.text });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await space.send(text(`agent error: ${reason}`));
  } finally {
    await space.stopTyping();
  }
}
