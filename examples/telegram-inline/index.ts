/**
 * Telegram Inline Bot — demonstrates Spectrum's event streams with inline mode.
 *
 * Setup:
 *   1. Open Telegram and message @BotFather
 *   2. Send /newbot, follow the prompts to create a bot, copy the token
 *   3. Send /setinline to @BotFather, pick your bot, set a placeholder like "Type something..."
 *   4. Set TELEGRAM_BOT_TOKEN=<your token> in your environment
 *   5. Run: bun run start
 *   6. In any Telegram chat, type @yourbot hello — you'll see 4 inline results
 */

import type { InlineQueryResult } from "@grammyjs/types";
import { Spectrum, text } from "spectrum-ts";
import { telegram } from "spectrum-ts/providers/telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("Set TELEGRAM_BOT_TOKEN first — see comment above");
}

const app = await Spectrum({
  providers: [telegram.config({ token })],
});

const tg = telegram(app);

// --- Inline queries: user types @yourbot <query> in any chat ---

(async () => {
  for await (const query of tg.inlineQueries) {
    const input = query.query.trim() || "hello";

    const results: InlineQueryResult[] = [
      {
        type: "article",
        id: "echo",
        title: "Echo",
        description: `Send: ${input}`,
        input_message_content: { message_text: input },
      },
      {
        type: "article",
        id: "shout",
        title: "Shout",
        description: `Send: ${input.toUpperCase()}`,
        input_message_content: {
          message_text: `<b>${input.toUpperCase()}</b>`,
          parse_mode: "HTML",
        },
      },
      {
        type: "article",
        id: "reverse",
        title: "Reverse",
        description: `Send: ${[...input].reverse().join("")}`,
        input_message_content: {
          message_text: [...input].reverse().join(""),
        },
      },
      {
        type: "article",
        id: "poll",
        title: "Poll",
        description: `Create a yes/no poll: "${input}"`,
        input_message_content: { message_text: `📊 Poll: ${input}` },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "👍 Yes",
                callback_data: `vote:yes:${input.slice(0, 40)}`,
              },
              { text: "👎 No", callback_data: `vote:no:${input.slice(0, 40)}` },
            ],
          ],
        },
      },
    ];

    await telegram.answerInlineQuery(tg.client, query.id, results, {
      cacheTime: 5,
    });
  }
})();

// --- Chosen results: track which option the user picked ---

(async () => {
  for await (const chosen of tg.chosenInlineResults) {
    console.log(`User picked "${chosen.resultId}" for query "${chosen.query}"`);
  }
})();

// --- Callback queries: handle poll votes from inline results ---

(async () => {
  for await (const query of tg.callbackQueries) {
    if (!query.data?.startsWith("vote:")) {
      continue;
    }

    const [, vote, topic] = query.data.split(":");
    await telegram.answerCallbackQuery(tg.client, query.id, {
      text: `You voted ${vote === "yes" ? "👍" : "👎"} on "${topic}"`,
    });
  }
})();

// --- DM fallback: echo messages sent directly to the bot ---

(async () => {
  for await (const [space, message] of app.messages) {
    if (message.content.type === "text") {
      await space.send(text(`echo: ${message.content.text}`));
    }
  }
})();

console.log("Bot running — type @yourbot <query> in any Telegram chat");
