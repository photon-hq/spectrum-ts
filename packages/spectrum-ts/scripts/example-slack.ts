#!/usr/bin/env bun

/**
 * End-to-end exerciser for the slack provider on spectrum-ts.
 *
 * Mirrors ../slack-ts/scripts/example.ts but routes universal features
 * (send, reply, react, file upload, message stream) through spectrum-ts and
 * reaches into the underlying slack-ts client only for slack-specific surface
 * that spectrum-ts intentionally doesn't expose (Block Kit, replyBroadcast,
 * markRead, AbortSignal cancellation, files.getUrl, fetchMissed, custom
 * CursorStore, TypedEventStream operators).
 *
 * Each section logs what it's about to do and catches its own errors so a
 * single failure doesn't abort the rest of the smoke test.
 *
 * Usage:
 *   SPECTRUM_CLOUD_URL=https://staging-spectrum-cloud.photon.codes \
 *   SPECTRUM_SLACK_ENDPOINT=staging-slack-grpc.spectrum.photon.codes:443 \
 *   bun run scripts/example-slack.ts
 */

import { Buffer } from "node:buffer";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  AuthenticationError,
  actions,
  button,
  ConnectionError,
  type CursorStore,
  context,
  createClient,
  createInMemoryCursorStore,
  divider,
  ErrorCode,
  header,
  NotFoundError,
  PermissionError,
  RateLimitError,
  type SlackClient,
  SlackError,
  type SlackEvent,
  section,
  attachments as slackAttachmentsBuilder,
  blocks as slackBlocksBuilder,
  staticTokens,
  ValidationError,
} from "@photon-ai/slack";
import { asAttachment } from "../src/content/attachment";
import { reaction } from "../src/content/reaction";
import { text } from "../src/content/text";
import { Spectrum } from "../src/index";
import { slack } from "../src/providers/slack";
import type { OutboundMessage } from "../src/types/message";
import { cloud } from "../src/utils/cloud";

const STREAM_TIMEOUT_MS = 30_000;
const CURSOR_STORE_TIMEOUT_MS = 5000;
const ON_CALLBACK_DELAY_MS = 1000;
const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5000;
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_MULTIPLIER = 2;
const FETCH_MISSED_LIMIT = 10;

const log = (msg: string): void => {
  console.log(msg);
};

const logError = (where: string, err: unknown): void => {
  if (err instanceof Error) {
    console.error(`[${where}] ${err.constructor.name}: ${err.message}`);
  } else {
    console.error(`[${where}] non-Error thrown: ${String(err)}`);
  }
};

const runSection = async (
  title: string,
  fn: () => Promise<void>
): Promise<void> => {
  log(`\n=== ${title} ===`);
  try {
    await fn();
  } catch (err) {
    logError(title, err);
  }
};

const formatErrorClass = (err: unknown): string =>
  err instanceof Error ? err.constructor.name : typeof err;

// ---------------------------------------------------------------------------
// Prompt for inputs
// ---------------------------------------------------------------------------

const rl = createInterface({ input: stdin, output: stdout });
const projectId = (await rl.question("projectId: ")).trim();
const projectSecret = (await rl.question("projectSecret: ")).trim();
const teamId = (await rl.question("teamId (T...): ")).trim();
const channel = (await rl.question("channel (C...): ")).trim();
const skipStreamingRaw = (
  await rl.question("skip streaming sections? [y/N]: ")
).trim();
rl.close();

const skipStreaming = skipStreamingRaw.toLowerCase().startsWith("y");

// ---------------------------------------------------------------------------
// Section 1 — Spectrum init (cloud mode)
// ---------------------------------------------------------------------------

log("\n=== 1. Spectrum() with slack.config() in cloud mode ===");
const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [slack.config()],
});
log("created Spectrum instance with slack provider");

// Reach into the runtime registry for the raw slack-ts client. spectrum-ts
// doesn't surface this as a public API yet; for slack-specific calls that the
// universal Space/Message surface can't express (Block Kit, markRead, abort,
// fetchMissed, operators, cursor store), the runtime client is the bridge.
const runtime = app.__internal.platforms.get("Slack");
if (!runtime) {
  throw new Error("Slack platform runtime is missing — Spectrum init failed");
}
const client = runtime.client as SlackClient;

// Resolve the test space (channel) once — every send section reuses it.
const space = await slack(app).space({ channel, teamId });
log(`resolved space id=${space.id} teamId=${space.teamId}`);

// State shared between sections.
let postedMessage: OutboundMessage | undefined;

try {
  // -------------------------------------------------------------------------
  // Section 2 — teams() discovery (raw client)
  // -------------------------------------------------------------------------
  await runSection("2. client.teams() via runtime", async () => {
    const teams = await client.teams();
    log(`teams.size=${teams.size}`);
    for (const [id, meta] of teams) {
      log(
        `  ${id} name=${meta.teamName} bot=${meta.botUserId} app=${meta.appId} scopes=[${meta.grantedScopes.join(",")}]`
      );
    }
  });

  // -------------------------------------------------------------------------
  // Section 3 — team() caching
  // -------------------------------------------------------------------------
  await runSection("3. client.team() caching", async () => {
    const a = client.team(teamId);
    const b = client.team(teamId);
    log(`teamId=${a.teamId} cached=${a === b}`);
  });

  const team = client.team(teamId);

  // -------------------------------------------------------------------------
  // Section 3b — messages.whoAmI (raw client; resolves the installed bot
  // identity from the server-side installation cache — no Slack round-trip)
  // -------------------------------------------------------------------------
  await runSection("3b. messages.whoAmI via raw client", async () => {
    const identity = await team.messages.whoAmI();
    log(
      `ok botUserId=${identity.botUserId} teamId=${identity.teamId} appId=${identity.appId}`
    );
  });

  // -------------------------------------------------------------------------
  // Section 4 — send variants via spectrum-ts where possible
  // -------------------------------------------------------------------------
  await runSection("4a. space.send(text(...))", async () => {
    const result = await space.send(text("hello from example-slack.ts"));
    if (!result) {
      log("send returned undefined (fire-and-forget content?)");
      return;
    }
    postedMessage = result;
    log(`ok id=${result.id} space=${result.space.id}`);
  });

  await runSection("4b. send text via SpectrumInstance.send", async () => {
    const result = await app.send(space, text("hello (via app.send)"));
    if (!Array.isArray(result) && result) {
      log(`ok id=${result.id}`);
    } else {
      log("unexpected result shape");
    }
  });

  await runSection(
    "4c. blocks via raw client (slack-only; not in universal Content)",
    async () => {
      const result = await team.messages.send({
        channel: space.id,
        ...slackBlocksBuilder(
          [
            header("Demo header"),
            section("Hello *world* — section with fields and accessory", {
              fields: ["field A", "field B"],
              accessory: button("Open", {
                actionId: "open",
                url: "https://example.com",
                style: "primary",
              }),
            }),
            divider(),
            context("rendered via context()"),
            actions(
              button("Click me", {
                actionId: "click",
                value: "v",
                style: "danger",
              })
            ),
          ],
          "Fallback text for notifications"
        ),
      });
      log(`ok ts=${result.ts}`);
    }
  );

  await runSection("4d. attachments via raw client (slack-only)", async () => {
    const result = await team.messages.send({
      channel: space.id,
      ...slackAttachmentsBuilder(
        [{ color: "#36a64f", text: "attached body" }],
        "Preface text"
      ),
    });
    log(`ok ts=${result.ts}`);
  });

  await runSection("4e. space.send(reaction(...))", async () => {
    if (!postedMessage) {
      log("skipped — no prior message");
      return;
    }
    await space.send(reaction("thumbsup", postedMessage));
    log("ok reaction added (fire-and-forget)");
  });

  // -------------------------------------------------------------------------
  // Section 5 — Thread reply via message.reply, replyBroadcast via raw client
  // -------------------------------------------------------------------------
  await runSection("5a. message.reply (auto threadTs)", async () => {
    if (!postedMessage) {
      log("skipped — no prior message");
      return;
    }
    const result = await postedMessage.reply(text("threaded reply via .reply"));
    if (result) {
      log(`ok id=${result.id}`);
    }
  });

  await runSection(
    "5b. replyBroadcast via raw client (not in spectrum surface)",
    async () => {
      if (!postedMessage) {
        log("skipped — no prior message");
        return;
      }
      const result = await team.messages.send({
        channel: space.id,
        threadTs: postedMessage.id,
        replyBroadcast: true,
        text: "threaded reply, broadcast to channel",
      });
      log(`ok ts=${result.ts}`);
    }
  );

  // -------------------------------------------------------------------------
  // Section 6 — messages.markRead (raw client; spectrum has no equivalent)
  // -------------------------------------------------------------------------
  await runSection("6. messages.markRead via raw client", async () => {
    if (!postedMessage) {
      log("skipped — no prior message");
      return;
    }
    await team.messages.markRead({ channel: space.id, ts: postedMessage.id });
    log(`ok marked ts=${postedMessage.id} as read`);
  });

  // -------------------------------------------------------------------------
  // Section 7 — AbortSignal (raw client; spectrum has no signal on send)
  // -------------------------------------------------------------------------
  await runSection("7. AbortSignal cancellation via raw client", async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await team.messages.send(
        { channel: space.id, text: "should never post" },
        { signal: controller.signal }
      );
      log(`unexpected success ts=${result.ts}`);
    } catch (err) {
      log(`caught ${formatErrorClass(err)}: aborted as expected`);
    }
  });

  // -------------------------------------------------------------------------
  // Section 8 — files.upload via universal attachment + raw client
  // -------------------------------------------------------------------------
  await runSection(
    "8a. space.send(attachment(...)) — string body via Buffer",
    async () => {
      const buf = Buffer.from("uploaded via Buffer content (spectrum)", "utf8");
      const result = await space.send(
        // `attachment(input, options)` accepts string|Buffer; for inline string
        // bytes we wrap in Buffer first (string means path, not bytes).
        // Use `asAttachment` directly to keep an in-memory builder for the demo.
        wrapBufferAttachment(buf, "hello-buffer.txt", "text/plain")
      );
      if (result) {
        log(`ok id=${result.id}`);
      }
    }
  );

  await runSection("8b. raw client files.upload (Uint8Array)", async () => {
    const bytes = new TextEncoder().encode("uploaded via Uint8Array content");
    const result = await team.files.upload({
      channel: space.id,
      filename: "hello-bytes.txt",
      mimeType: "text/plain",
      content: bytes,
    });
    log(`ok file id=${result.file.id}`);
    const urlResult = await team.files.getUrl(result.file.id);
    log(`  signed url=${urlResult.url}`);
  });

  await runSection(
    "8c. raw client files.upload (string body) + initialComment",
    async () => {
      const result = await team.files.upload({
        channel: space.id,
        filename: "hello-string.txt",
        mimeType: "text/plain",
        content: "uploaded via string content (raw)",
        initialComment: "string upload demo",
        threadTs: postedMessage?.id,
      });
      log(
        `ok file id=${result.file.id} name=${result.file.name} size=${result.file.size}`
      );
    }
  );

  // -------------------------------------------------------------------------
  // Section 9 — Error taxonomy via instanceof
  // -------------------------------------------------------------------------
  await runSection("9a. NotFoundError / ValidationError", async () => {
    try {
      await team.messages.send({
        channel: "C_DOES_NOT_EXIST",
        text: "should fail",
      });
      log("unexpected success");
    } catch (err) {
      describeSlackError(err);
    }
  });

  await runSection("9b. synchronous TypeError from coerceContent", async () => {
    try {
      await team.files.upload({
        channel: space.id,
        filename: "bad.bin",
        mimeType: "application/octet-stream",
        content: 123 as unknown as Uint8Array,
      });
      log("unexpected success");
    } catch (err) {
      const isSlack = err instanceof SlackError;
      log(
        `caught ${formatErrorClass(err)} (instanceof SlackError = ${isSlack})`
      );
      if (err instanceof Error) {
        log(`  message: ${err.message}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Section 10 + 11 — Streaming via spectrum messages stream + raw client
  // -------------------------------------------------------------------------
  let lastCursor: string | undefined;

  if (skipStreaming) {
    log("\n=== 10–11. streaming sections skipped ===");
  } else {
    await runSection(
      "10a. app.messages + manual take(3) via break",
      async () => {
        let received = 0;
        const timeout = setTimeout(() => {
          log("  timeout reached, stopping");
        }, STREAM_TIMEOUT_MS);
        try {
          for await (const [, message] of app.messages) {
            log(
              `  [spectrum] type=${message.content.type} sender=${message.sender.id}`
            );
            received += 1;
            if (received >= 3) {
              break;
            }
          }
        } finally {
          clearTimeout(timeout);
        }
        log(`  observed ${received} message(s) via spectrum stream`);
      }
    );

    await runSection(
      "10b. raw events.subscribe + .filter (type-narrow)",
      async () => {
        const stream = team.events.subscribe({
          reconnect: {
            initialDelay: RECONNECT_INITIAL_DELAY_MS,
            maxDelay: RECONNECT_MAX_DELAY_MS,
            maxAttempts: RECONNECT_MAX_ATTEMPTS,
            multiplier: RECONNECT_MULTIPLIER,
            onReconnect: (attempt) =>
              log(`  reconnecting (attempt ${attempt})`),
          },
        });
        const onlyMessages = stream.filter(
          (e): e is Extract<SlackEvent, { type: "message" }> =>
            e.type === "message"
        );
        const timeout = setTimeout(() => {
          onlyMessages.close().catch(() => undefined);
        }, STREAM_TIMEOUT_MS);
        try {
          for await (const ev of onlyMessages.take(1)) {
            log(
              `  message from ${ev.message.user}: ${ev.message.text.slice(0, 80)}`
            );
            lastCursor = ev.cursor;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    );

    await runSection("10c. raw events.subscribe + .map", async () => {
      const stream = team.events.subscribe();
      const projected = stream
        .map((e) => ({ type: e.type, cursor: e.cursor }))
        .take(1);
      const timeout = setTimeout(() => {
        projected.close().catch(() => undefined);
      }, STREAM_TIMEOUT_MS);
      try {
        for await (const ev of projected) {
          log(`  mapped: type=${ev.type} cursor=${ev.cursor}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    });

    await runSection(
      "10d. raw events.subscribe + .on() unsubscribe",
      async () => {
        const stream = team.events.subscribe();
        let count = 0;
        const unsubscribe = stream.on((ev) => {
          count += 1;
          log(`  on() received type=${ev.type} (count=${count})`);
        });
        await new Promise((resolve) =>
          setTimeout(resolve, ON_CALLBACK_DELAY_MS)
        );
        unsubscribe();
        log(`  unsubscribed after ${count} events`);
      }
    );

    await runSection(
      "10e. raw events.subscribe + await using (asyncDispose)",
      async () => {
        await using stream = team.events.subscribe();
        const inner = stream.take(1);
        const timeout = setTimeout(() => {
          inner.close().catch(() => undefined);
        }, STREAM_TIMEOUT_MS);
        try {
          for await (const ev of inner) {
            log(`  observed type=${ev.type}`);
            lastCursor = ev.cursor;
          }
        } finally {
          clearTimeout(timeout);
        }
        log("  block exiting — await using will dispose stream");
      }
    );

    await runSection("11. events.fetchMissed via raw client", async () => {
      if (!lastCursor) {
        log("skipped — no cursor captured (channel was quiet)");
        return;
      }
      const result = await team.events.fetchMissed({
        cursor: lastCursor,
        limit: FETCH_MISSED_LIMIT,
      });
      log(`ok events=${result.events.length} hasMore=${result.hasMore}`);
    });
  }

  // -------------------------------------------------------------------------
  // Section 12 — Custom CursorStore (raw client; not exposed via slack.config)
  // -------------------------------------------------------------------------
  if (skipStreaming) {
    log("\n=== 12. custom CursorStore skipped (streaming disabled) ===");
  } else {
    await runSection(
      "12. custom CursorStore (instrumented) via raw client",
      async () => {
        const instrumented = makeLoggingCursorStore();
        // Mint a one-shot token via the cloud endpoint our provider also
        // uses. slack.config() doesn't accept a CursorStore today (the
        // spectrum-ts surface uses an in-memory store internally), so build
        // a parallel slack-ts client with the real JWT and the instrumented
        // store. This is a faithful port of the slack-ts example, not a
        // recommended spectrum-ts pattern.
        const minted = await cloud.issueSlackTokens(projectId, projectSecret);
        const firstTeam = Object.keys(minted.auth)[0];
        const realJwt = firstTeam ? minted.auth[firstTeam] : undefined;
        if (!(firstTeam && realJwt)) {
          log("skipped — no teams in project");
          return;
        }
        const client12 = createClient({
          cursorStore: instrumented,
          spectrumSlackEndpoint: process.env.SPECTRUM_SLACK_ENDPOINT,
          tokenProvider: staticTokens({ tokens: { [firstTeam]: realJwt } }),
        });
        try {
          const stream = client12.team(firstTeam).events.subscribe();
          const timeout = setTimeout(() => {
            stream.close().catch(() => undefined);
          }, CURSOR_STORE_TIMEOUT_MS);
          try {
            for await (const ev of stream.take(1)) {
              log(`  observed event type=${ev.type}`);
            }
          } finally {
            clearTimeout(timeout);
          }
        } finally {
          await client12.close();
        }
      }
    );
  }

  // -------------------------------------------------------------------------
  // Section 13 — staticTokens direct mode (spectrum-ts)
  // -------------------------------------------------------------------------
  await runSection(
    "13. slack.config({ tokens, teams }) direct mode",
    async () => {
      const direct = await Spectrum({
        providers: [
          slack.config({
            endpoint: process.env.SPECTRUM_SLACK_ENDPOINT,
            teams: {
              [teamId]: {
                appId: "A-APP",
                botUserId: "U-BOT",
                grantedScopes: ["chat:write"],
                teamName: "Acme (static)",
              },
            },
            tokens: { [teamId]: "ey.fake.jwt" },
          }),
        ],
      });
      try {
        const directRuntime = direct.__internal.platforms.get("Slack");
        const directClient = directRuntime?.client as SlackClient;
        const directTeams = await directClient.teams();
        log(`direct staticTokens listTeams.size=${directTeams.size}`);
        for (const [id, meta] of directTeams) {
          log(
            `  ${id} name=${meta.teamName} scopes=[${meta.grantedScopes.join(",")}]`
          );
        }
      } finally {
        await direct.stop();
      }
    }
  );
} catch (err) {
  logError("top-level", err);
  process.exitCode = 1;
} finally {
  log("\n=== closing app ===");
  await app.stop();
  log("done");
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function wrapBufferAttachment(
  buf: Buffer,
  name: string,
  mimeType: string
): { build: () => Promise<ReturnType<typeof asAttachment>> } {
  // `attachment(input, opts)` reads from a path when `input` is a string.
  // For inline bytes from this script, hand-roll an asAttachment so we don't
  // touch the filesystem.
  return {
    build: async () =>
      asAttachment({
        name,
        mimeType,
        size: buf.byteLength,
        read: async () => buf,
      }),
  };
}

function describeSlackError(err: unknown): void {
  if (err instanceof AuthenticationError) {
    log(`AuthenticationError code=${err.code} grpc=${err.grpcCode}`);
    return;
  }
  if (err instanceof PermissionError) {
    log(`PermissionError kind=${err.permission.kind}`);
    if (err.permission.kind === "feature_not_enabled") {
      log(`  feature=${err.permission.feature}`);
    } else if (err.permission.kind === "other") {
      log(`  detail=${err.permission.detail ?? "<none>"}`);
    }
    return;
  }
  if (err instanceof NotFoundError) {
    log(`NotFoundError code=${err.code} msg=${err.message}`);
    return;
  }
  if (err instanceof RateLimitError) {
    log(`RateLimitError retryAfterMs=${err.retryAfterMs ?? "<none>"}`);
    return;
  }
  if (err instanceof ValidationError) {
    log(`ValidationError code=${err.code} msg=${err.message}`);
    return;
  }
  if (err instanceof ConnectionError) {
    log(`ConnectionError code=${err.code} msg=${err.message}`);
    return;
  }
  if (err instanceof SlackError) {
    log(
      `SlackError (base) code=${err.code} grpc=${err.grpcCode} retryable=${err.retryable}`
    );
    if (err.code === ErrorCode.internalError) {
      log("  (note: ErrorCode.internalError reached)");
    }
    return;
  }
  log(`non-SlackError: ${formatErrorClass(err)}`);
}

function makeLoggingCursorStore(): CursorStore {
  const inner = createInMemoryCursorStore();
  return {
    async get(id) {
      const value = await inner.get(id);
      log(`  cursorStore.get(${id}) -> ${value ?? "<undefined>"}`);
      return value;
    },
    async set(id, cursor) {
      log(`  cursorStore.set(${id}, ${cursor})`);
      await inner.set(id, cursor);
    },
  };
}
