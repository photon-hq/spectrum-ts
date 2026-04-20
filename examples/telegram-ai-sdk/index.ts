import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
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

const strictness = (process.env.STRICTNESS ?? "medium") as
  | "low"
  | "medium"
  | "high";

const WARN_LIMIT = 3;
const MUTE_SECONDS = 3600;

// --- State ---

const warnings = new Map<string, number>();
const confirmedUsers = new Set<string>();

// --- AI Classification ---

const classificationSchema = z.object({
  category: z.enum(["spam", "scam", "toxic", "off_topic", "safe"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

type Classification = z.infer<typeof classificationSchema>;

const thresholds: Record<string, number> = {
  low: 0.9,
  medium: 0.7,
  high: 0.5,
};

const classify = async (content: string): Promise<Classification> => {
  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: classificationSchema,
    prompt: [
      "Classify this group chat message into exactly one category:",
      "- spam: unsolicited ads, promotions, repeated content",
      "- scam: phishing, fake giveaways, suspicious links, crypto scams",
      "- toxic: harassment, hate speech, personal attacks",
      "- off_topic: completely unrelated to group discussion",
      "- safe: normal, acceptable conversation",
      "",
      `Message: "${content}"`,
    ].join("\n"),
  });
  return object;
};

// --- Helpers ---

const addWarning = (userId: string): number => {
  const count = (warnings.get(userId) ?? 0) + 1;
  warnings.set(userId, count);
  return count;
};

const muteUntil = () => Math.floor(Date.now() / 1000) + MUTE_SECONDS;

const reviewButtons = (chatId: string, msgId: string, userId: string) => ({
  inline_keyboard: [
    [
      {
        text: "🗑 Delete",
        callback_data: `mod:delete:${chatId}:${msgId}:${userId}`,
      },
      {
        text: "⚠️ Warn",
        callback_data: `mod:warn:${chatId}:${msgId}:${userId}`,
      },
      { text: "✅ Ignore", callback_data: `mod:ignore:${chatId}:${msgId}` },
    ],
  ],
});

// --- Boot ---

const bot = new Bot(token);
const app = await Spectrum({
  providers: [telegram.config({ token })],
});
const threshold = thresholds[strictness];

// --- Moderation handlers (extracted to reduce complexity) ---

const handleSpam = async (
  space: {
    deleteMessage: (id: string) => Promise<void>;
    send: (...c: unknown[]) => Promise<void>;
  },
  chatId: string,
  msgId: string,
  userId: string,
  result: Classification,
  confident: boolean
) => {
  await space.deleteMessage(msgId);

  if (!confident) {
    await space.send(text(`Message removed (likely ${result.category}).`));
    return;
  }

  await bot.api.restrictChatMember(Number(chatId), Number(userId), {
    permissions: { can_send_messages: false },
    until_date: muteUntil(),
  });
  const count = addWarning(userId);

  if (count >= WARN_LIMIT) {
    await bot.api.banChatMember(Number(chatId), Number(userId));
    await space.send(text(`User banned after ${WARN_LIMIT} violations.`));
  } else {
    await space.send(
      text(
        `Message removed (${result.category}). User muted 1hr. Warning ${count}/${WARN_LIMIT}.`
      )
    );
  }
};

const handleToxic = async (
  space: {
    deleteMessage: (id: string) => Promise<void>;
    send: (...c: unknown[]) => Promise<void>;
  },
  chatId: string,
  msgId: string,
  userId: string,
  result: Classification,
  confident: boolean
) => {
  if (!confident) {
    await bot.api.sendMessage(
      Number(chatId),
      `⚠️ Flagged (${Math.round(result.confidence * 100)}%): ${result.reason}\nMods, please review:`,
      { reply_markup: reviewButtons(chatId, msgId, userId) }
    );
    return;
  }

  await space.deleteMessage(msgId);
  const count = addWarning(userId);

  if (count >= WARN_LIMIT) {
    await bot.api.banChatMember(Number(chatId), Number(userId));
    await space.send(text(`User banned after ${WARN_LIMIT} violations.`));
  } else {
    await bot.api.sendMessage(
      Number(chatId),
      `Message removed for violating group rules. Warning ${count}/${WARN_LIMIT}.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Appeal", callback_data: `appeal:${userId}:${msgId}` }],
          ],
        },
      }
    );
  }
};

// --- Message moderation loop ---

(async () => {
  for await (const [space, message] of app.messages) {
    if (message.content.type !== "text") {
      continue;
    }

    let result: Classification;
    try {
      result = await classify(message.content.text);
    } catch {
      continue;
    }

    if (result.category === "safe") {
      continue;
    }

    const confident = result.confidence >= threshold;
    const { id: chatId } = space;
    const userId = message.sender.id;

    if (result.category === "spam" || result.category === "scam") {
      await handleSpam(space, chatId, message.id, userId, result, confident);
    } else if (result.category === "toxic") {
      await handleToxic(space, chatId, message.id, userId, result, confident);
    } else if (result.category === "off_topic" && confident) {
      await message.react("🤔");
      await message.reply(
        "This seems off-topic. Consider posting in a more relevant channel."
      );
    }
  }
})();

// --- Callback query handlers (split by prefix) ---

const handleModAction = async (
  data: string,
  query: { id: string; messageId?: string; space?: { id: string } }
) => {
  const [, action, , targetMsgId, targetUserId] = data.split(":");
  const chatId = Number(query.space?.id);

  if (action === "delete" && targetMsgId) {
    try {
      await bot.api.deleteMessage(chatId, Number(targetMsgId));
    } catch {
      /* already deleted */
    }
    if (targetUserId) {
      addWarning(targetUserId);
    }
    await bot.api.answerCallbackQuery(query.id, { text: "Deleted & warned." });
    if (query.messageId) {
      await bot.api.editMessageText(
        chatId,
        Number(query.messageId),
        "✅ Handled: message deleted, user warned."
      );
    }
  } else if (action === "warn" && targetUserId) {
    const count = addWarning(targetUserId);
    await bot.api.answerCallbackQuery(query.id, {
      text: `Warning ${count}/${WARN_LIMIT}.`,
    });
  } else if (action === "ignore" && query.messageId) {
    await bot.api.answerCallbackQuery(query.id, { text: "Marked safe." });
    await bot.api.editMessageText(
      chatId,
      Number(query.messageId),
      "✅ Reviewed: no action taken."
    );
  }
};

const handleAppeal = async (
  data: string,
  query: { id: string; sender: { id: string } }
) => {
  const appealUserId = data.split(":")[1];
  const isOwner = query.sender.id === appealUserId;
  await bot.api.answerCallbackQuery(query.id, {
    text: isOwner
      ? "Appeal noted. A moderator will review."
      : "Only the warned user can appeal.",
    show_alert: isOwner,
  });
};

const handleWelcome = async (
  data: string,
  query: {
    id: string;
    messageId?: string;
    sender: { id: string };
    space?: { id: string };
  }
) => {
  const welcomeUserId = data.split(":")[1];
  const chatId = Number(query.space?.id);

  if (query.sender.id !== welcomeUserId) {
    await bot.api.answerCallbackQuery(query.id, {
      text: "This button is not for you.",
    });
    return;
  }

  confirmedUsers.add(welcomeUserId);
  await bot.api.restrictChatMember(chatId, Number(welcomeUserId), {
    permissions: {
      can_send_messages: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
    },
  });
  await bot.api.answerCallbackQuery(query.id, {
    text: "Welcome! You can now chat.",
    show_alert: true,
  });
  if (query.messageId) {
    await bot.api.editMessageText(
      chatId,
      Number(query.messageId),
      "✅ User confirmed the rules."
    );
  }
};

(async () => {
  for await (const query of app.events.telegram.callbackQueries) {
    const data = query.data;
    if (!(data && query.space)) {
      continue;
    }

    if (data.startsWith("mod:")) {
      await handleModAction(data, query);
    } else if (data.startsWith("appeal:")) {
      await handleAppeal(data, query);
    } else if (data.startsWith("welcome:")) {
      await handleWelcome(data, query);
    }
  }
})();

// --- New member welcome flow ---

(async () => {
  for await (const update of app.events.telegram.chatMemberUpdates) {
    if (update.newStatus !== "member") {
      continue;
    }

    const chatId = Number(update.space.id);
    const userId = Number(update.userId);

    await bot.api.sendMessage(
      chatId,
      [
        "Welcome! Please read the group rules and confirm below.",
        "",
        "• Be respectful — no harassment or hate speech",
        "• No spam, scams, or self-promotion",
        "• Stay on topic",
        "",
        "Tap the button within 5 minutes or you'll be muted.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ I agree to the rules",
                callback_data: `welcome:${update.userId}`,
              },
            ],
          ],
        },
      }
    );

    setTimeout(
      async () => {
        if (confirmedUsers.has(update.userId)) {
          return;
        }
        try {
          await bot.api.restrictChatMember(chatId, userId, {
            permissions: { can_send_messages: false },
          });
        } catch {
          // User may have left
        }
      },
      5 * 60 * 1000
    );
  }
})();

console.log(
  `🛡️ Moderator bot running (strictness: ${strictness}, warn limit: ${WARN_LIMIT})`
);
