import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { timeTool } from "../tools/time";
import { weatherTool } from "../tools/weather";

/**
 * The chat assistant: Claude (via the AI SDK Anthropic provider) with the
 * weather and time tools. Tool descriptions carry the when-to-call guidance;
 * the instructions keep replies chat-sized and plain-text.
 */
export const assistant = new Agent({
  id: "spectrum-assistant",
  name: "Spectrum Assistant",
  instructions: [
    "You are a friendly assistant chatting over a messaging app.",
    "Use get-weather when the user asks about weather conditions, and get-time when they ask about the current time or date.",
    "Answer in plain conversational text (no markdown) and keep replies short — this is a chat interface.",
  ].join("\n"),
  model: anthropic("claude-opus-4-8"),
  tools: { weatherTool, timeTool },
});
