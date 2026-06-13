import { reaction, reply, Spectrum, text } from "spectrum-ts";
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

  // Inbound reactions are now first-class `reaction` content (upstream
  // spectrum-ts PR #31) — no more custom-content wrapping.
  if (
    message.content.type === "reaction" &&
    message.content.target.content.type === "text"
  ) {
    console.log(
      `reaction ${message.content.emoji} on msg ${message.content.target.content.text.slice(0, 8)}…`
    );
    continue;
  }

  // Normal message — possibly a reply.
  if (message.content.type !== "text") {
    continue;
  }

  // Sugar form: message.react delegates to space.send(reaction(emoji, self))
  // and resolves to the reaction Message — the handle for a future unsend.
  const sent = await message.react("👀");
  console.log(`reacted ${sent?.content.emoji} → id ${sent?.id}`);
  // Canonical form: reaction as first-class content via space.send.
  await space.send(reaction("✨", message));

  const replyTo = (message as { replyTo?: { messageId: string } }).replyTo;
  if (replyTo) {
    console.log(
      `REPLY to ${replyTo.messageId.slice(0, 8)}…: "${message.content.text}"`
    );
    // Direct: reply as first-class content.
    await space.send(reply(text("ack via space.send(reply(...))"), message));
    // Sugar: same end result, message.reply delegates to space.send(reply(...)).
    await message.reply(text("ack via message.reply(...)"));
  } else {
    console.log(`message: "${message.content.text}"`);
    await space.send(text(`echo: ${message.content.text}`));
  }
}
