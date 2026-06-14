import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { configSchema, directConfigSchema } from "@/providers/x/config";
import { x } from "@/providers/x/index";
import { cloud } from "@/utils/cloud";
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

describe("x createClient cloud mode", () => {
  afterEach(() => {
    mock.restore();
  });

  it("does not register webhooks at startup without appBearerToken", async () => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue({
      auth: { "42": "cloud-access-token" },
      accounts: { a: { xUserId: "42" } },
      consumerSecret: "cloud-consumer-secret",
      expiresIn: 900,
    });

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(Response.json({ data: [] }))) as unknown as typeof fetch);

    const store = createStore();
    const config = configSchema.parse({});

    await x.config({}).__definition.lifecycle.createClient({
      config,
      projectId: "proj",
      projectSecret: "secret",
      projectConfig,
      store,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cloud.issueXCredentials).toHaveBeenCalledWith("proj", "secret");
  });

  it("registers the Fusor webhook when appBearerToken and slug are present", async () => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue({
      auth: { "42": "cloud-access-token" },
      accounts: { a: { xUserId: "42" } },
      consumerSecret: "cloud-consumer-secret",
      expiresIn: 900,
    });

    const calls: Array<[string, string]> = [];
    spyOn(globalThis, "fetch").mockImplementation(((
      input: Request | string | URL,
      init?: RequestInit
    ) => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push([request.method, url.pathname]);

      if (request.method === "GET" && url.pathname === "/2/webhooks") {
        return Promise.resolve(
          Response.json({ data: [{ id: "hook-existing", url: EXPECTED_URL }] })
        );
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/2/account_activity/webhooks/")
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        Response.json({ message: "unexpected" }, { status: 500 })
      );
    }) as unknown as typeof fetch);

    const store = createStore();
    const config = configSchema.parse({ appBearerToken: APP_BEARER });

    await x
      .config({ appBearerToken: APP_BEARER })
      .__definition.lifecycle.createClient({
        config,
        projectId: "proj",
        projectSecret: "secret",
        projectConfig,
        store,
      });

    expect(calls.map((call) => [call[0], call[1]])).toEqual([
      ["GET", "/2/webhooks"],
      ["POST", "/2/account_activity/webhooks/hook-existing/subscriptions/all"],
    ]);
  });

  it("throws when projectId and projectSecret are missing", async () => {
    const store = createStore();
    const config = configSchema.parse({});

    await expect(
      x.config({}).__definition.lifecycle.createClient({
        config,
        projectConfig,
        store,
      })
    ).rejects.toThrow("X cloud mode requires projectId and projectSecret");
  });
});

describe("x createClient direct mode", () => {
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

  it("registers the Fusor webhook when projectConfig.slug is present", async () => {
    listBody = { data: [{ id: "hook-existing", url: EXPECTED_URL }] };

    const store = createStore();
    await x.config(directConfig).__definition.lifecycle.createClient({
      config: directConfig,
      projectConfig,
      store,
    });

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/2/webhooks"],
      ["POST", "/2/account_activity/webhooks/hook-existing/subscriptions/all"],
    ]);
    expect(calls[0]?.authorization).toBe(`Bearer ${APP_BEARER}`);
    expect(calls[1]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("creates the webhook when none exists, then subscribes", async () => {
    const store = createStore();
    await x.config(directConfig).__definition.lifecycle.createClient({
      config: directConfig,
      projectConfig,
      store,
    });

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/2/webhooks"],
      ["POST", "/2/webhooks"],
      ["POST", "/2/account_activity/webhooks/hook-new/subscriptions/all"],
    ]);
    expect(calls[1]?.body).toEqual({ url: EXPECTED_URL });
  });

  it("skips webhook registration without projectConfig.slug", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(Response.json({ data: [] }))) as unknown as typeof fetch);

    const store = createStore();
    await x.config(directConfig).__definition.lifecycle.createClient({
      config: directConfig,
      store,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
