import { Spectrum, text } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({ providers: [terminal.config()] });

// Seed each new space with something to reply/react to.
const seeded = new Set<string>();

for await (const [space, message] of app.messages) {
  // Raw shape dump so we can verify replyTo / reaction fields landed.
  console.log("RAW:", JSON.stringify(message, null, 0));

  if (!seeded.has(space.id)) {
    seeded.add(space.id);
    await space.send(text("hi! reply to me or react with ↑ → r/e"));
  }

  if (
    message.content.type === "custom" &&
    typeof message.content.raw === "object" &&
    message.content.raw !== null &&
    (message.content.raw as { terminal_type?: string }).terminal_type ===
      "reaction"
  ) {
    const r = message.content.raw as { messageId: string; reaction: string };
    console.log(`reaction ${r.reaction} on msg ${r.messageId.slice(0, 8)}…`);
    continue;
  }

  // Normal message — possibly a reply.
  if (message.content.type !== "text") {
    continue;
  }

  // Always react with 👀 first so we can verify the agent → user reaction path.
  await message.react("👀");

  const replyTo = (message as { replyTo?: { messageId: string } }).replyTo;
  if (replyTo) {
    console.log(
      `REPLY to ${replyTo.messageId.slice(0, 8)}…: "${message.content.text}"`
    );
    await message.reply(text("acknowledged your reply"));
  } else {
    console.log(`message: "${message.content.text}"`);
    await space.send(text(`echo: ${message.content.text}`));
  }
}
