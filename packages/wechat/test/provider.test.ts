import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdown, Spectrum, text } from "@spectrum-ts/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wechat } from "@/index";
import {
  BASE_URL,
  BOT_TOKEN,
  hang,
  inboundText,
  mockILink,
  ok,
  USER_ID,
} from "./helpers";

const GET_UPDATES = "ilink/bot/getupdates";
const SEND = "ilink/bot/sendmessage";
const NOTIFY_START = "ilink/bot/msg/notifystart";
const NOTIFY_STOP = "ilink/bot/msg/notifystop";
const QR_CODE = "ilink/bot/get_bot_qrcode";
const QR_STATUS = "ilink/bot/get_qrcode_status";
const STOP_BUDGET_MS = 2000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spectrum-wechat-e2e-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const firstMessage = async (app: Awaited<ReturnType<typeof Spectrum>>) => {
  const first = await app.messages[Symbol.asyncIterator]().next();
  if (first.done) {
    throw new Error("expected an inbound message");
  }
  return first.value;
};

describe("wechat provider", () => {
  it("receives a message, replies with its context token, and stops promptly", async () => {
    const ilink = mockILink({
      [NOTIFY_START]: ok(),
      [NOTIFY_STOP]: ok(),
      [GET_UPDATES]: [
        ok({ msgs: [inboundText("ping")], get_updates_buf: "c1" }),
        hang,
      ],
      [SEND]: ok({ message_id: "501" }),
    });
    const app = await Spectrum({
      providers: [wechat.config({ botToken: BOT_TOKEN, baseUrl: BASE_URL })],
    });

    const [space, message] = await firstMessage(app);
    expect(message.platform).toBe("wechat");
    expect(message.content).toEqual({ type: "text", text: "ping" });
    expect(space.id).toBe(USER_ID);

    const sent = await space.send(text("pong"));
    // Markdown is downgraded to plain text by core.
    await space.send(markdown("**bold**"));

    expect(sent?.id).toBe("501");
    const bodies = ilink
      .callsTo(SEND)
      .map((call) => call.body?.msg as Record<string, unknown>);
    expect(bodies.map((msg) => msg.item_list)).toEqual([
      [{ type: 1, text_item: { text: "pong" } }],
      [{ type: 1, text_item: { text: "bold" } }],
    ]);
    expect(bodies.every((msg) => msg.context_token === "ctx-1")).toBe(true);

    const started = performance.now();
    await app.stop();
    expect(performance.now() - started).toBeLessThan(STOP_BUDGET_MS);
    expect(ilink.callsTo(NOTIFY_START)).toHaveLength(1);
    expect(ilink.callsTo(NOTIFY_STOP)).toHaveLength(1);
  });

  it("logs in with a QR code, saves the state file, and reuses it", async () => {
    const stateFile = join(dir, "wechat.json");
    const ilink = mockILink({
      [QR_CODE]: ok({ qrcode: "q1", qrcode_img_content: "https://qr.test/1" }),
      [QR_STATUS]: ok({
        status: "confirmed",
        bot_token: "fresh-token",
        ilink_bot_id: "bot@im.bot",
        baseurl: BASE_URL,
      }),
      [NOTIFY_START]: ok(),
      [NOTIFY_STOP]: ok(),
      [GET_UPDATES]: [
        ok({ msgs: [inboundText("hi")], get_updates_buf: "c1" }),
        hang,
      ],
    });
    const onQrCode = vi.fn();

    const first = await Spectrum({
      providers: [wechat.config({ stateFile, login: { onQrCode } })],
    });
    await firstMessage(first);
    await first.stop();

    expect(onQrCode).toHaveBeenCalledWith("https://qr.test/1");
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    expect(saved).toMatchObject({
      credentials: { botToken: "fresh-token", botId: "bot@im.bot" },
      cursor: "c1",
      contextTokens: { [USER_ID]: "ctx-1" },
    });

    const second = await Spectrum({
      providers: [wechat.config({ stateFile, login: { onQrCode } })],
    });
    await second.stop();

    expect(ilink.callsTo(QR_CODE)).toHaveLength(1);
    expect(
      ilink.callsTo(NOTIFY_START).at(-1)?.headers.get("Authorization")
    ).toBe("Bearer fresh-token");
  });
});
