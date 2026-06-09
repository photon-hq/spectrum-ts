import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { configSchema } from "@/providers/telegram/config";
import { ensureWebhook, webhookUrl } from "@/providers/telegram/webhook";

const SLUG = "what-c62a6";
const SECRET = "s3cr3t_token-123";
const BOT_TOKEN = "42:supersecret";
const EXPECTED_URL = `https://${SLUG}.spctrm.dev/telegram`;

interface Captured {
  json?: Record<string, unknown>;
  method: string;
}

const config = (secret?: string) =>
  configSchema.parse({
    botToken: BOT_TOKEN,
    ...(secret ? { webhookSecret: secret } : {}),
  });

let calls: Captured[];
let currentUrl: string;
let failMethod: string | null;
let originalSuperWebhook: string | undefined;

beforeEach(() => {
  calls = [];
  currentUrl = "";
  failMethod = null;
  originalSuperWebhook = process.env.SPECTRUM_SUPER_WEBHOOK;
  // Truly unset so the default-domain test is deterministic.
  delete process.env.SPECTRUM_SUPER_WEBHOOK;

  const impl = (input: Request): Promise<Response> => {
    const url = input.url;
    const method = url.slice(url.lastIndexOf("/") + 1);
    return (async (): Promise<Response> => {
      const isJson = input.headers
        .get("content-type")
        ?.includes("application/json");
      calls.push({
        json: isJson
          ? ((await input.clone().json()) as Record<string, unknown>)
          : undefined,
        method,
      });
      if (failMethod === method) {
        return Response.json(
          { description: "bad request", error_code: 400, ok: false },
          { status: 400 }
        );
      }
      if (method === "getWebhookInfo") {
        return Response.json({
          ok: true,
          result: {
            has_custom_certificate: false,
            pending_update_count: 0,
            url: currentUrl,
          },
        });
      }
      return Response.json({ ok: true, result: true });
    })();
  };
  spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch
  );
});

afterEach(() => {
  if (originalSuperWebhook === undefined) {
    delete process.env.SPECTRUM_SUPER_WEBHOOK;
  } else {
    process.env.SPECTRUM_SUPER_WEBHOOK = originalSuperWebhook;
  }
  mock.restore();
});

describe("webhookUrl", () => {
  it("builds the Fusor edge URL from the slug on the default domain", () => {
    expect(webhookUrl(SLUG)).toBe(EXPECTED_URL);
  });

  it("honors the SPECTRUM_SUPER_WEBHOOK domain override", () => {
    process.env.SPECTRUM_SUPER_WEBHOOK = "staging.spctrm.dev";
    expect(webhookUrl(SLUG)).toBe(
      `https://${SLUG}.staging.spctrm.dev/telegram`
    );
  });
});

describe("ensureWebhook", () => {
  it("skips setWebhook when the webhook URL is already registered", async () => {
    currentUrl = EXPECTED_URL;
    await ensureWebhook(config(), SLUG);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("getWebhookInfo");
  });

  it("registers the webhook with secret_token when a webhookSecret is set", async () => {
    await ensureWebhook(config(SECRET), SLUG);
    expect(calls.map((c) => c.method)).toEqual([
      "getWebhookInfo",
      "setWebhook",
    ]);
    expect(calls[1]?.json).toEqual({
      secret_token: SECRET,
      url: EXPECTED_URL,
    });
  });

  it("registers the webhook without secret_token when no webhookSecret is set", async () => {
    await ensureWebhook(config(), SLUG);
    expect(calls[1]?.method).toBe("setWebhook");
    expect(calls[1]?.json).toEqual({ url: EXPECTED_URL });
  });

  it("registers when a different URL is already set", async () => {
    currentUrl = "https://stale.example.com/telegram";
    await ensureWebhook(config(), SLUG);
    expect(calls[1]?.method).toBe("setWebhook");
    expect(calls[1]?.json).toEqual({ url: EXPECTED_URL });
  });

  it("throws a token-free error when the Bot API call fails", async () => {
    failMethod = "setWebhook";
    let thrown: unknown;
    try {
      await ensureWebhook(config(SECRET), SLUG);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "Telegram webhook registration failed"
    );
    expect((thrown as Error).message).not.toContain(BOT_TOKEN);
  });
});
