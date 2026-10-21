import { cloud, Spectrum } from "@spectrum-ts/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "@/config";
import { telegram } from "@/index";
import { ensureWebhook, webhookUrl } from "@/webhook";

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
  vi.spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch
  );
});

afterEach(() => {
  if (originalSuperWebhook === undefined) {
    delete process.env.SPECTRUM_SUPER_WEBHOOK;
  } else {
    process.env.SPECTRUM_SUPER_WEBHOOK = originalSuperWebhook;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  it("forwards lifecycle cancellation to webhook registration without returning a client", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<AbortSignal>();
    vi.mocked(globalThis.fetch).mockImplementationOnce((input, init) => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      started.resolve(request.signal);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true }
        );
      });
    });
    const startup = new AbortController();
    const reason = new DOMException("startup deadline", "TimeoutError");
    const projectLookup = vi.spyOn(cloud, "getProject").mockResolvedValue({
      id: "project-1",
      name: "Test project",
      profile: {},
      slug: SLUG,
    });
    const platformsLookup = vi.spyOn(cloud, "getPlatforms").mockResolvedValue({
      imessage: { enabled: false },
      slack: { enabled: false },
      whatsapp_business: { enabled: false },
    });
    try {
      const pending = Spectrum({
        projectId: "project-1",
        projectSecret: "secret-1",
        providers: [telegram.config({ botToken: BOT_TOKEN })],
        signal: startup.signal,
      });
      const rejection = expect(pending).rejects.toBe(reason);
      const received = await started.promise;
      expect(received.aborted).toBe(false);
      startup.abort(reason);
      await rejection;
      expect(received.aborted).toBe(true);
      expect(received.reason).toBe(reason);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      startup.abort(reason);
      projectLookup.mockRestore();
      platformsLookup.mockRestore();
    }
  });

  it("rejects an already-aborted signal without making any requests", async () => {
    const reason = new DOMException("startup deadline", "TimeoutError");
    await expect(
      ensureWebhook(config(), SLUG, AbortSignal.abort(reason))
    ).rejects.toBe(reason);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "getWebhookInfo",
    "setWebhook",
  ])("rejects a late successful %s response after cancellation", async (method) => {
    const existing = vi.mocked(globalThis.fetch).getMockImplementation();
    if (!existing) {
      throw new Error("missing test fetch");
    }
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      const response = await existing(input, init);
      if (request.url.endsWith(`/${method}`)) {
        started.resolve();
        await release.promise;
      }
      return response;
    });
    const startup = new AbortController();
    const reason = new DOMException("startup deadline", "TimeoutError");
    const pending = ensureWebhook(config(), SLUG, startup.signal);
    const rejection = expect(pending).rejects.toBe(reason);
    await started.promise;
    startup.abort(reason);
    release.resolve();
    await rejection;
    expect(calls.map((call) => call.method)).toEqual(
      method === "getWebhookInfo"
        ? ["getWebhookInfo"]
        : ["getWebhookInfo", "setWebhook"]
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(calls.length);
  });

  it.each([
    "getWebhookInfo",
    "setWebhook",
  ])("cancels %s with the startup signal", async (method) => {
    const existing = vi.mocked(globalThis.fetch).getMockImplementation();
    if (!existing) {
      throw new Error("missing test fetch");
    }
    const started = Promise.withResolvers<AbortSignal>();
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      if (request.url.endsWith(`/${method}`)) {
        started.resolve(request.signal);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          );
        });
      }
      return existing(input, init);
    });
    const controller = new AbortController();
    const pending = ensureWebhook(config(), SLUG, controller.signal);
    const received = await started.promise;
    const reason = new DOMException("startup deadline", "TimeoutError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(received.aborted).toBe(true);
  });

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
