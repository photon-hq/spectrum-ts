import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { directConfigSchema } from "@/providers/x/config";
import { x } from "@/providers/x/index";
import { createStore } from "@/utils/store";

const SLUG = "test-project";
const EXPECTED_URL = `https://${SLUG}.spctrm.dev/x`;
const ACCESS_TOKEN = "user-access-token";
const APP_BEARER = "app-bearer-token";

const directConfig = directConfigSchema.parse({
  consumerSecret: "consumer-secret",
  accessToken: ACCESS_TOKEN,
  xUserId: "42",
  appBearerToken: APP_BEARER,
});

const projectConfig = {
  id: "proj",
  name: "Test",
  profile: {},
  slug: SLUG,
};

describe("x createClient", () => {
  interface CapturedCall {
    authorization: string | null;
    body?: Record<string, unknown>;
    method: string;
    path: string;
  }

  let calls: CapturedCall[];
  let listBody: unknown;
  let createBody: unknown;
  let subscribeStatus: number;

  beforeEach(() => {
    calls = [];
    listBody = { data: [] };
    createBody = { data: { id: "hook-new", url: EXPECTED_URL } };
    subscribeStatus = 204;

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
          return Response.json(listBody, { status: 200 });
        }
        if (request.method === "POST" && url.pathname === "/2/webhooks") {
          return Response.json(createBody, { status: 201 });
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
    mock.restore();
  });

  // Webhook registration is no longer done in createClient — it triggers X's
  // CRC, which must be answered by a listening webhook server, so registration
  // is explicit (the app calls `ensureWebhook` after its server is up). See
  // webhook.test.ts for the ensureWebhook coverage.
  it("returns a fusor client without registering a webhook", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(Response.json({ data: [] }))) as unknown as typeof fetch);

    const store = createStore();
    const def = x.config(directConfig).__definition;
    const client = await def.lifecycle.createClient({
      config: directConfig,
      projectConfig,
      store,
    });

    expect(client.platform).toBe("x");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
