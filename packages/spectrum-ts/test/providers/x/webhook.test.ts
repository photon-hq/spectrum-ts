import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { ensureWebhook, webhookUrl } from "@/providers/x/webhook";

const SLUG = "project-x";
const EXPECTED_URL = `https://${SLUG}.spctrm.dev/x`;
const ACCESS_TOKEN = "user-access-token";
const APP_BEARER = "app-bearer-token";

interface CapturedCall {
  authorization: string | null;
  body?: Record<string, unknown>;
  method: string;
  path: string;
}

const webhookInput = {
  appBearerToken: APP_BEARER,
  accessToken: ACCESS_TOKEN,
};

let calls: CapturedCall[];
let listStatus: number;
let listBody: unknown;
let createStatus: number;
let createBody: unknown;
let subscribeStatus: number;
let originalSuperWebhook: string | undefined;

beforeEach(() => {
  calls = [];
  listStatus = 200;
  listBody = { data: [] };
  createStatus = 201;
  createBody = { data: { id: "hook-created", url: EXPECTED_URL } };
  subscribeStatus = 204;
  originalSuperWebhook = process.env.SPECTRUM_SUPER_WEBHOOK;
  delete process.env.SPECTRUM_SUPER_WEBHOOK;

  const impl = (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> =>
    (async (): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const contentType = request.headers.get("content-type");
      const body =
        contentType?.includes("application/json") &&
        request.method !== "GET" &&
        request.method !== "HEAD"
          ? ((await request.clone().json()) as Record<string, unknown>)
          : undefined;

      calls.push({
        path: url.pathname,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body,
      });

      if (request.method === "GET" && url.pathname === "/2/webhooks") {
        return Response.json(listBody, { status: listStatus });
      }
      if (request.method === "POST" && url.pathname === "/2/webhooks") {
        return Response.json(createBody, { status: createStatus });
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/2/account_activity/webhooks/") &&
        url.pathname.endsWith("/subscriptions/all")
      ) {
        if (subscribeStatus === 204) {
          return new Response(null, { status: 204 });
        }
        return Response.json({}, { status: subscribeStatus });
      }
      return Response.json({ message: "unexpected route" }, { status: 500 });
    })();

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

describe("x webhookUrl", () => {
  it("builds the default super webhook URL", () => {
    expect(webhookUrl(SLUG)).toBe(EXPECTED_URL);
  });

  it("honors SPECTRUM_SUPER_WEBHOOK override", () => {
    process.env.SPECTRUM_SUPER_WEBHOOK = "staging.spctrm.dev";
    expect(webhookUrl(SLUG)).toBe(`https://${SLUG}.staging.spctrm.dev/x`);
  });
});

describe("x ensureWebhook", () => {
  it("reuses an existing webhook id and only subscribes", async () => {
    listBody = { data: [{ id: "hook-existing", url: EXPECTED_URL }] };

    await ensureWebhook(webhookInput, SLUG);

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/2/webhooks"],
      ["POST", "/2/account_activity/webhooks/hook-existing/subscriptions/all"],
    ]);
    expect(calls[0]?.authorization).toBe(`Bearer ${APP_BEARER}`);
    expect(calls[1]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("creates the webhook when none exists, then subscribes", async () => {
    listBody = { data: [] };
    createBody = { data: { id: "hook-new", url: EXPECTED_URL } };

    await ensureWebhook(webhookInput, SLUG);

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/2/webhooks"],
      ["POST", "/2/webhooks"],
      ["POST", "/2/account_activity/webhooks/hook-new/subscriptions/all"],
    ]);
    expect(calls[1]?.body).toEqual({ url: EXPECTED_URL });
  });

  it("treats a 409 subscription response as already subscribed", async () => {
    listBody = { data: [{ id: "hook-existing", url: EXPECTED_URL }] };
    subscribeStatus = 409;

    await expect(ensureWebhook(webhookInput, SLUG)).resolves.toBeUndefined();
  });

  it("treats DuplicateSubscriptionFailed as already subscribed", async () => {
    listBody = { data: [{ id: "hook-existing", url: EXPECTED_URL }] };
    subscribeStatus = 403;
    spyOn(globalThis, "fetch").mockImplementation((async (
      input: Request | string | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/2/webhooks") {
        return Response.json(listBody, { status: 200 });
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/2/account_activity/webhooks/")
      ) {
        return Response.json(
          {
            errors: [
              {
                detail:
                  "DuplicateSubscriptionFailed: Subscription already exists",
              },
            ],
          },
          { status: 403 }
        );
      }
      return Response.json({ message: "unexpected route" }, { status: 500 });
    }) as unknown as typeof fetch);

    await expect(ensureWebhook(webhookInput, SLUG)).resolves.toBeUndefined();
  });

  it("throws a token-free error when creation fails", async () => {
    listBody = { data: [] };
    createStatus = 400;
    createBody = { errors: [{ detail: "bad webhook url" }] };

    let thrown: unknown;
    try {
      await ensureWebhook(webhookInput, SLUG);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("X webhook registration failed");
    expect(message).not.toContain(APP_BEARER);
    expect(message).not.toContain(ACCESS_TOKEN);
  });
});
