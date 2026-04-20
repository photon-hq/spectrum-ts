import { openai } from "@ai-sdk/openai";
import type { InlineQueryResult } from "@grammyjs/types";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Bot } from "grammy";
import { Spectrum, text } from "spectrum-ts";
import { telegram } from "spectrum-ts/providers/telegram";
import { z } from "zod";

// --- Configuration ---

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN");
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

// --- Tools ---

const searchWikipedia = createTool({
  id: "search-wikipedia",
  description:
    "Search Wikipedia for factual information. Returns a summary and link.",
  inputSchema: z.object({
    query: z.string().describe("The topic to search for"),
  }),
  outputSchema: z.object({
    title: z.string(),
    summary: z.string(),
    url: z.string(),
  }),
  execute: async ({ query }) => {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
    );
    if (!res.ok) {
      return {
        title: query,
        summary: `No Wikipedia article found for "${query}".`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(query)}`,
      };
    }
    const data = (await res.json()) as {
      title: string;
      extract: string;
      content_urls?: { desktop?: { page?: string } };
    };
    return {
      title: data.title,
      summary: data.extract ?? "No summary available.",
      url:
        data.content_urls?.desktop?.page ??
        `https://en.wikipedia.org/wiki/${encodeURIComponent(query)}`,
    };
  },
});

const calculateMath = createTool({
  id: "calculate-math",
  description: "Evaluate a mathematical expression.",
  inputSchema: z.object({
    expression: z.string().describe("e.g. '2 + 2' or '100 * 1.08'"),
  }),
  outputSchema: z.object({
    result: z.string(),
  }),
  execute: async ({ expression }) => {
    try {
      const sanitized = expression.replace(/[^0-9+\-*/().%^ ]/g, "");
      const result = new Function(`return (${sanitized})`)() as number;
      return { result: `${expression} = ${result}` };
    } catch {
      return { result: `Could not evaluate: ${expression}` };
    }
  },
});

// --- Agent ---

const agent = new Agent({
  name: "Knowledge Agent",
  instructions: [
    "You are a knowledgeable assistant.",
    "Use searchWikipedia for factual topics, calculateMath for calculations.",
    "Be concise and accurate.",
  ].join(" "),
  model: openai("gpt-4o-mini"),
  tools: { searchWikipedia, calculateMath },
});

// --- Boot ---

const bot = new Bot(token);
const app = await Spectrum({
  providers: [telegram.config({ token })],
});

// --- Inline query result builders ---

const buildInlineResults = (
  input: string,
  shortAnswer: string,
  fullAnswer: string
): InlineQueryResult[] => [
  {
    type: "article",
    id: "quick",
    title: "⚡ Quick answer",
    description: shortAnswer.slice(0, 100),
    input_message_content: {
      message_text: shortAnswer,
      parse_mode: "HTML" as const,
    },
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📖 More detail", callback_data: "detail" },
          { text: "🔗 Sources", callback_data: "sources" },
        ],
      ],
    },
  },
  {
    type: "article",
    id: "detailed",
    title: "📖 Detailed explanation",
    description: fullAnswer.slice(0, 100),
    input_message_content: {
      message_text: fullAnswer,
      parse_mode: "HTML" as const,
    },
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🧒 Simplify", callback_data: "simplify" },
          { text: "🔗 Sources", callback_data: "sources" },
        ],
      ],
    },
  },
  {
    type: "article",
    id: "eli5",
    title: "🧒 ELI5 (Explain like I'm 5)",
    description: `Simple explanation of: ${input.slice(0, 80)}`,
    input_message_content: {
      message_text: `🧒 <b>ELI5:</b> ${shortAnswer}`,
      parse_mode: "HTML" as const,
    },
    reply_markup: {
      inline_keyboard: [[{ text: "📖 More detail", callback_data: "detail" }]],
    },
  },
];

// --- Inline queries ---

(async () => {
  for await (const query of app.events.telegram.inlineQueries) {
    const input = query.query.trim();
    if (!input) {
      await bot.api.answerInlineQuery(query.id, []);
      continue;
    }

    let agentResponse: string;
    try {
      const result = await agent.generate(`Answer concisely: ${input}`);
      agentResponse = result.text;
    } catch {
      agentResponse = `I couldn't process "${input}". Try rephrasing.`;
    }

    const sentences = agentResponse.split(". ").filter(Boolean);
    const shortAnswer =
      sentences.slice(0, 2).join(". ") + (sentences.length > 2 ? "." : "");

    await bot.api.answerInlineQuery(
      query.id,
      buildInlineResults(input, shortAnswer, agentResponse),
      { cache_time: 30 }
    );
  }
})();

// --- Callback queries for inline buttons ---

const handleInlineCallback = async (
  action: string,
  query: { id: string; messageId?: string; space?: { id: string } }
) => {
  const prompts: Record<string, string> = {
    detail: "Give a detailed explanation of the topic in the message above.",
    simplify: "Simplify the above message so a child could understand it.",
    sources:
      "List 2-3 reliable sources for the information in the message above.",
  };

  const prompt = prompts[action];
  if (!prompt) {
    return;
  }

  let response: string;
  try {
    const result = await agent.generate(prompt);
    if (action === "simplify") {
      response = `🧒 ${result.text}`;
    } else if (action === "sources") {
      response = `🔗 <b>Sources:</b>\n${result.text}`;
    } else {
      response = result.text;
    }
  } catch {
    response = "Sorry, I couldn't process that.";
  }

  if (query.messageId && query.space) {
    try {
      await bot.api.editMessageText(
        Number(query.space.id),
        Number(query.messageId),
        response,
        { parse_mode: "HTML" }
      );
    } catch {
      // Message may have expired
    }
  }

  await bot.api.answerCallbackQuery(query.id);
};

(async () => {
  for await (const query of app.events.telegram.callbackQueries) {
    const data = query.data;
    if (!data) {
      continue;
    }
    await handleInlineCallback(data, query);
  }
})();

// --- Chosen inline results: analytics ---

(async () => {
  for await (const chosen of app.events.telegram.chosenInlineResults) {
    console.log(
      `[analytics] User ${chosen.userId} picked "${chosen.resultId}" for "${chosen.query}"`
    );
  }
})();

// --- DM mode: conversational research ---

(async () => {
  for await (const [space, message] of app.messages) {
    if (message.content.type !== "text") {
      continue;
    }

    await space.responding(async () => {
      let response: string;
      try {
        const result = await agent.generate(message.content.text);
        response = result.text;
      } catch {
        response = "Sorry, something went wrong. Try again.";
      }

      const parts = response.split("\n\n").filter(Boolean);
      for (const part of parts) {
        await space.send(text(part));
      }
    });
  }
})();

console.log(
  "🔍 Inline Knowledge Agent running. Try @bot <query> in any chat, or DM directly."
);
