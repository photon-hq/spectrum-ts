// Inbound inspector — dumps every event Spectrum surfaces: text, attachments,
// voice, richlinks, reactions (add/remove), and the `custom` fallback for
// stickers/polls/embeds. Full detail to the terminal, a compact copy back to the
// channel. (On the Discord gateway path the adapter thins the raw payload, so
// stickers/polls land as `custom { chatsdk_type: "empty" }` — an upstream limit.)
//
// Run: bun inspect  (then throw text, files, links, reactions, … at the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import type { Content, Message } from "spectrum-ts";
import { Spectrum } from "spectrum-ts";
import { chatSDK, messageMeta } from "spectrum-ts/providers/chat-sdk";

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
});

const describeContent = async (content: Content): Promise<string> => {
  switch (content.type) {
    case "text":
      return `text: ${JSON.stringify(content.text)}`;
    case "markdown":
      return `markdown: ${JSON.stringify(content.markdown)}`;
    case "attachment":
      return `attachment: name=${content.name} mime=${content.mimeType} size=${content.size ?? "?"}`;
    case "voice":
      return `voice: name=${content.name} mime=${content.mimeType} size=${content.size ?? "?"}`;
    case "richlink": {
      const [title, summary] = await Promise.all([
        content.title().catch(() => undefined),
        content.summary().catch(() => undefined),
      ]);
      return [
        `richlink: ${content.url}`,
        `  title:   ${title ?? "—"}`,
        `  summary: ${summary ?? "—"}`,
      ].join("\n");
    }
    case "reaction":
      return `reaction: ${content.action ?? "add"} ${content.emoji} → target ${content.target.id}`;
    case "poll":
      return `poll: ${content.title}\n${content.options.map((o) => `  • ${o.title}`).join("\n")}`;
    case "custom":
      return `custom:\n${JSON.stringify(content.raw, null, 2)}`;
    default:
      return `${content.type}:\n${JSON.stringify(content, null, 2)}`;
  }
};

const describeMessage = async (message: Message): Promise<string> => {
  const { isMention, edited, editedAt, links } = messageMeta(message);
  const meta = [
    `id:        ${message.id}`,
    `sender:    ${message.sender?.id ?? "?"}`,
    `at:        ${message.timestamp.toISOString()}`,
    `mention:   ${isMention}`,
    `edited:    ${edited}${edited && editedAt ? ` @ ${editedAt.toISOString()}` : ""}`,
    `links:     ${links.length}`,
  ];
  return [
    `── inbound [${message.content.type}] ──`,
    ...meta,
    await describeContent(message.content),
  ].join("\n");
};

for await (const [, message] of app.messages) {
  const detail = await describeMessage(message);
  process.stdout.write(`${detail}\n\n`);

  // Discord caps messages ~2000 chars; reply threads the dump onto its source.
  try {
    await message.reply(`\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``);
  } catch (error) {
    process.stderr.write(`reply skipped: ${(error as Error).message}\n`);
  }
}
