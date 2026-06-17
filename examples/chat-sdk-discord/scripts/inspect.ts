// Inbound inspector — prints whatever you send, however weird.
//
// Dumps every inbound event Spectrum surfaces from the chat SDK: text,
// attachments, voice, richlinks (unfurled links), reactions (add AND remove),
// and the `custom` fallback that catches sticker-only / poll / embed-only
// messages that used to vanish. Full detail goes to the terminal; a compact
// summary is echoed back into the channel so you can see it from Discord too.
//
// Run: bun run inspect.ts
// Then throw things at the bot: text, a file, a voice note, a link, a sticker,
// a poll, an embed-only link, and add/remove a reaction on its messages.
//
// Note: on the Discord *gateway* path the adapter strips the raw payload down,
// so a sticker/poll surfaces as `custom { chatsdk_type: "empty" }` with thin
// `raw` — you'll see THAT something arrived, but not its native details. That's
// an upstream adapter limitation, not Spectrum's.

import type { Content, Message } from "spectrum-ts";
import { Spectrum } from "spectrum-ts";
import { chatSDK, messageMeta } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

// Render one content value as human-readable lines. Accessors on richlink are
// async, so this is async too.
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
      // The new add/remove discriminator — `action` is "add" | "remove"
      // ("add" when a provider omits it).
      return `reaction: ${content.action ?? "add"} ${content.emoji} → target ${content.target.id}`;

    case "poll":
      return `poll: ${content.title}\n${content.options.map((o) => `  • ${o.title}`).join("\n")}`;

    case "custom":
      // The catch-all: sticker-only / poll / embed-only messages land here as
      // `{ chatsdk_type: "empty", raw }`. Dump the raw so you can see it all.
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
  const body = await describeContent(message.content);
  return [`── inbound [${message.content.type}] ──`, ...meta, body].join("\n");
};

for await (const [, message] of app.messages) {
  const detail = await describeMessage(message);

  // Full detail to the terminal.
  process.stdout.write(`${detail}\n\n`);

  // Reply with the meta as a (threaded) reply to the message it describes, so
  // the dump is attached to its source. Discord caps messages ~2000 chars.
  try {
    await message.reply(`\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``);
  } catch (error) {
    process.stderr.write(`reply skipped: ${(error as Error).message}\n`);
  }
}
