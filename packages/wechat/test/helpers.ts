import type { Store } from "@spectrum-ts/core";
import { vi } from "vitest";
import type { WeChatClient } from "@/client";
import { openState } from "@/state";

export const BOT_TOKEN = "bot-token-secret";
export const BASE_URL = "https://ilink.test";
export const USER_ID = "o9cq80user@im.wechat";

/** One request the fake iLink server received. */
export interface ILinkCall {
  body: Record<string, unknown> | undefined;
  headers: Headers;
  method: string;
  /** Host + path without the leading slash, e.g. `ilink/bot/getupdates`. */
  path: string;
  signal: AbortSignal | undefined;
  url: URL;
}

export type ILinkHandler = (call: ILinkCall) => Response | Promise<Response>;

/** Resolves only when the request is aborted — an idle long-poll. */
export const hang = (call: ILinkCall): Promise<Response> =>
  new Promise((_, reject) => {
    const { signal } = call;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

/**
 * Replace `globalThis.fetch` with an in-memory iLink. Each path maps to a
 * handler, or to a queue of handlers consumed in order (the last one repeats).
 * Unknown paths fail the request with HTTP 404.
 */
export const mockILink = (
  routes: Record<string, ILinkHandler | ILinkHandler[]>
) => {
  const calls: ILinkCall[] = [];
  const queues = new Map(
    Object.entries(routes).map(([path, handler]) => [
      path,
      Array.isArray(handler) ? [...handler] : [handler],
    ])
  );
  const impl = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
    const url = new URL(request.url);
    const text = await request.text();
    const call: ILinkCall = {
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      headers: request.headers,
      method: request.method,
      path: url.pathname.slice(1),
      // The caller's own signal keeps its abort reason (e.g. TimeoutError).
      signal: init?.signal ?? request.signal,
      url,
    };
    calls.push(call);
    const queue = queues.get(call.path);
    const handler = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!handler) {
      return new Response("not found", { status: 404 });
    }
    return await handler(call);
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as typeof fetch);
  return {
    calls,
    callsTo: (path: string) => calls.filter((call) => call.path === path),
  };
};

export const ok =
  (body: Record<string, unknown> = {}): ILinkHandler =>
  () =>
    Response.json({ ret: 0, ...body });

/** A raw JSON body, for asserting lossless uint64 parsing. */
export const rawJson =
  (body: string): ILinkHandler =>
  () =>
    new Response(body, { headers: { "Content-Type": "application/json" } });

/** A Map-backed `Store` (core's own is internal). */
export const memoryStore = (): Store => {
  const data = new Map<string, unknown>();
  const typed =
    <T>(guard: (value: unknown) => boolean) =>
    (key: string): T | undefined => {
      const value = data.get(key);
      return guard(value) ? (value as T) : undefined;
    };
  return {
    array: typed(Array.isArray),
    bool: typed((value) => typeof value === "boolean"),
    clear: () => data.clear(),
    delete: (key) => data.delete(key),
    get: (key) => data.get(key),
    has: (key) => data.has(key),
    keys: () => [...data.keys()],
    number: typed((value) => typeof value === "number"),
    object: typed(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype
    ),
    set: (key, value) => {
      data.set(key, value);
    },
    string: typed((value) => typeof value === "string"),
  };
};

/** A ready client against `BASE_URL`, bypassing `createClient`'s login. */
export const testClient = async (
  contextTokens: Record<string, string> = {}
): Promise<WeChatClient> => {
  const state = await openState(memoryStore());
  state.setCredentials({ botToken: BOT_TOKEN, baseUrl: BASE_URL });
  for (const [userId, token] of Object.entries(contextTokens)) {
    state.setContextToken(userId, token);
  }
  return {
    shutdown: new AbortController(),
    state,
    target: { baseUrl: BASE_URL, botToken: BOT_TOKEN },
    typingTickets: new Map(),
  };
};

/** An inbound text message as `getupdates` returns it. */
export const inboundText = (
  text: string,
  overrides: Record<string, unknown> = {}
) => ({
  message_id: "7446744073709551615",
  from_user_id: USER_ID,
  to_user_id: "bot@im.bot",
  create_time_ms: 1_762_000_000_000,
  message_type: 1,
  message_state: 2,
  context_token: "ctx-1",
  item_list: [{ type: 1, text_item: { text } }],
  ...overrides,
});
