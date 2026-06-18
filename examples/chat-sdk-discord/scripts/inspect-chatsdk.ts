// Inbound inspector — PURE chat SDK, no Spectrum. Wired onto the SDK's own
// handlers so you see exactly what it delivers (text, attachments, links, the
// `formatted` AST, the platform `raw`, reaction add/remove). Useful to confirm
// where data lives: send a sticker and the SDK's Message arrives with text:""
// and no attachments — proof the loss is upstream, not in Spectrum's wrapper.
//
// The Gateway isn't serverless here, so we keep the socket alive in a loop
// (what Spectrum's provider does for you). Run: bun inspect-chatsdk  (Ctrl-C to stop)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Message, type ReactionEvent, type Thread } from "chat";

// Minimal shape of a Gateway-capable adapter (`getAdapter` returns `unknown`).
interface GatewayAdapter {
  startGatewayListener(
    options: { waitUntil?: (promise: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string
  ): Promise<unknown>;
}

const GATEWAY_WINDOW_MS = 180_000;
const TRUNCATE = 1800;

const bot = new Chat({
  userName: "spectrum-bot",
  adapters: { discord: createDiscordAdapter() },
  state: createMemoryState(),
});

const describeMessage = (kind: string, message: Message): string => {
  const a = message.author;
  const attachments = message.attachments ?? [];
  const links = message.links ?? [];
  return [
    `── chatsdk inbound [${kind}] ──`,
    `id:         ${message.id}`,
    `author:     ${a.userId} (${a.userName} / ${a.fullName}) bot=${a.isBot} me=${a.isMe}`,
    `text:       ${JSON.stringify(message.text)}`,
    `isMention:  ${message.isMention ?? false}`,
    `edited:     ${message.metadata?.edited ?? false}`,
    `attachments(${attachments.length}):${attachments
      .map(
        (att) =>
          `\n  • ${att.type} ${att.name ?? "?"} ${att.mimeType ?? ""} ${att.url ?? ""}`
      )
      .join("")}`,
    `links(${links.length}):${links.map((l) => `\n  • ${l.title ?? l.url}`).join("")}`,
    `formatted:  ${JSON.stringify(message.formatted)}`,
    `raw:\n${JSON.stringify(message.raw, null, 2)}`,
  ].join("\n");
};

const describeReaction = (event: ReactionEvent): string =>
  [
    "── chatsdk inbound [reaction] ──",
    `action:     ${event.added ? "add" : "remove"}`,
    `emoji:      ${event.rawEmoji} (${event.emoji?.name ?? "?"})`,
    `messageId:  ${event.messageId}`,
    `user:       ${event.user.userId} (${event.user.userName})`,
    `hasTarget:  ${event.message !== undefined}`,
  ].join("\n");

// Only the capability `report` needs — assignable from both message-handler and
// reaction-event thread types.
interface Replyable {
  post(message: string): Promise<unknown>;
}

// Print to the terminal AND post the dump back (the thread is the reply unit).
const report = async (thread: Replyable, detail: string) => {
  process.stdout.write(`${detail}\n\n`);
  try {
    await thread.post(`\`\`\`\n${detail.slice(0, TRUNCATE)}\n\`\`\``);
  } catch (error) {
    process.stderr.write(`reply skipped: ${(error as Error).message}\n`);
  }
};

const onMessage =
  (kind: string) => async (thread: Thread, message: Message) => {
    await thread.subscribe?.().catch(() => undefined); // keep follow-ups arriving
    await report(thread, describeMessage(kind, message));
  };

bot.onDirectMessage(onMessage("dm"));
bot.onNewMention(onMessage("mention"));
bot.onSubscribedMessage(onMessage("subscribed"));
bot.onReaction((event) => report(event.thread, describeReaction(event)));

await bot.initialize();

// Keep the Gateway socket alive until Ctrl-C.
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const adapter = bot.getAdapter?.("discord") as GatewayAdapter | undefined;
if (!adapter?.startGatewayListener) {
  throw new Error("discord adapter exposes no Gateway listener");
}

process.stdout.write(
  "inspector running — send the bot something. Ctrl-C to stop.\n\n"
);
while (!controller.signal.aborted) {
  const inflight: Promise<unknown>[] = [];
  await adapter.startGatewayListener(
    { waitUntil: (promise) => inflight.push(Promise.resolve(promise)) },
    GATEWAY_WINDOW_MS,
    controller.signal
  );
  await Promise.allSettled(inflight);
}

await bot.shutdown();
