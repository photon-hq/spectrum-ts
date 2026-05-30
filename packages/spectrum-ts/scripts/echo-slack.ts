#!/usr/bin/env bun

/**
 * Echo bot: subscribes to events for every team the project has installed and
 * replies in-thread to every plain user message with the same text/file
 * content.
 *
 * Mirrors ../slack-ts/scripts/echo.ts but routes through Spectrum's cloud
 * mode — the spectrum-cloud token endpoint provides both per-workspace JWTs
 * and the bot user id needed for self-filtering, so the script asks only for
 * the project credentials.
 *
 * Usage:
 *   SPECTRUM_SLACK_ENDPOINT=localhost:50051 \
 *   bun run scripts/echo-slack.ts
 *
 * Then enter your projectId and projectSecret at the prompt.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Content, ContentBuilder } from "../src/content/types";
import { Spectrum } from "../src/index";
import { imessage } from "../src/providers";

// `message.reply` expects a `ContentInput` (string | ContentBuilder) so it can
// re-resolve and validate the payload. Inbound `message.content` is already a
// resolved `Content`; wrap it back into a builder for pass-through echo.
const passthrough = (content: Content): ContentBuilder => ({
  build: async () => content,
});

const rl = createInterface({ input: stdin, output: stdout });
const projectId = (await rl.question("projectId: ")).trim();
const projectSecret = (await rl.question("projectSecret: ")).trim();
rl.close();

const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
});

console.log(`[echo] project=${projectId} — listening...`);

// Track in-flight reply tasks so SIGINT can drain them before exit. Replies
// are fire-and-forget from the event loop's perspective: spectrum-slack
// serializes outbound Slack calls per team (tier-2: 1 req / 3 s) so awaiting
// in the for-await would block ingestion behind the workspace's outbound
// rate limit and starve later events.
const inflight = new Set<Promise<void>>();

let shuttingDown = false;

const shutdown = async (): Promise<void> => {
  console.log(
    `[echo] stream ended, draining ${inflight.size} pending reply(ies)`
  );
  await Promise.allSettled([...inflight]);
  await app.stop();
};

process.on("SIGINT", () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("\n[echo] caught SIGINT, closing...");
  shutdown().catch((err) => {
    console.error("[echo] shutdown failed:", err);
  });
});

interface MessageExtras {
  isFromMe?: boolean;
  subtype?: string;
}

for await (const [space, message] of app.messages) {
  const extras = message as unknown as MessageExtras;
  console.log(
    `[echo] message id=${message.id} sender=${message.sender.id} subtype=${extras.subtype ?? ""}`
  );
  console.log(JSON.stringify(message.content, null, 2));

  // Skip system messages — only plain user messages and file shares.
  if (extras.subtype && extras.subtype !== "file_share") {
    continue;
  }
  // Skip our own posts (any bot in the project) so we don't echo ourselves
  // into a loop. spectrum-slack stamps `isFromMe` server-side against the
  // installation's bot user id, so we don't need to plumb it through here.
  if (extras.isFromMe) {
    continue;
  }
  // Skip reaction-shaped events (the slack provider funnels reactions through
  // `app.messages` as `reaction` content) and any placeholder empty-message
  // rows the provider falls back to.
  if (
    message.content.type === "reaction" ||
    message.content.type === "custom"
  ) {
    continue;
  }

  const task = (async () => {
    try {
      await message.reply(passthrough(message.content));
      console.log(
        `[echo] replied in ${space.id} (id=${message.id}, user=${message.sender.id})`
      );
    } catch (err) {
      console.error(`[echo] reply failed for id=${message.id}:`, err);
    }
  })().finally(() => {
    inflight.delete(task);
  });
  inflight.add(task);
}

await shutdown();
