// Inbound inspector — PURE chat SDK, no Spectrum.
//
// Same idea as `inspect.ts`, but wired straight onto the chat SDK's own
// handlers (onNewMention / onDirectMessage / onSubscribedMessage / onReaction)
// so you see exactly what the SDK itself delivers — text, attachments, links,
// the `formatted` AST, the platform `raw`, and reaction add/remove events.
//
// Use this to confirm where data lives (or doesn't): send a sticker and you'll
// see the SDK's own Message arrives with text:"" and no attachments — proof the
// loss is upstream in the adapter, not in Spectrum's wrapper.
//
// Run: bun run inspect-chatsdk.ts
//
// Regular messages/reactions arrive over the Discord Gateway, which is NOT
// serverless here — this script keeps the socket alive in a loop (the same
// thing Spectrum's provider does for you). Ctrl-C to stop.

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Message, type ReactionEvent, type Thread } from "chat";

// Minimal shape of a Gateway-capable adapter (Discord). `getAdapter` returns
// `unknown`, so we narrow to just the method we call.
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
  const lines = [
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
    `links(${links.length}):${links
      .map((l) => `\n  • ${l.title ?? l.url}`)
      .join("")}`,
    `formatted:  ${JSON.stringify(message.formatted)}`,
    `raw:\n${JSON.stringify(message.raw, null, 2)}`,
  ];
  return lines.join("\n");
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

// The only thread capability `report` needs — keeps it assignable from both
// `Thread<Record<string, unknown>>` (message handlers) and `Thread<unknown>`
// (reaction events).
interface Replyable {
  post(message: string): Promise<unknown>;
}

// Print to the terminal AND post the dump back into the thread. In chat-SDK
// land the thread is the reply unit, so `thread.post` is the reply.
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
    // Auto-subscribe so follow-ups keep arriving (same as Spectrum's wrapper).
    await thread.subscribe?.().catch(() => undefined);
    await report(thread, describeMessage(kind, message));
  };

bot.onDirectMessage(onMessage("dm"));
bot.onNewMention(onMessage("mention"));
bot.onSubscribedMessage(onMessage("subscribed"));
bot.onReaction((event) => report(event.thread, describeReaction(event)));

await bot.initialize();

// Keep the Discord Gateway socket alive in a loop until Ctrl-C.
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
