import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { markdown } from "@/content/markdown";
import { text } from "@/content/text";
import { configSchema } from "@/providers/x/config";
import { send } from "@/providers/x/outbound/send";

interface CapturedCall {
  authorization: string | null;
  body?: Record<string, unknown>;
  method: string;
  url: string;
}

const config = configSchema.parse({
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  xUserId: "42",
  appBearerToken: "app-bearer-token",
});

let calls: CapturedCall[];

beforeEach(() => {
  calls = [];
  const impl = (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> =>
    (async (): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      const contentType = request.headers.get("content-type");
      const body =
        contentType?.includes("application/json") &&
        request.method !== "GET" &&
        request.method !== "HEAD"
          ? ((await request.clone().json()) as Record<string, unknown>)
          : undefined;
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body,
      });
      return Response.json({
        data: {
          dm_conversation_id: "99-42",
          dm_event_id: "evt-1",
        },
      });
    })();
  spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch
  );
});

afterEach(() => {
  mock.restore();
});

describe("x outbound send", () => {
  it("sends text to a recipient user id and returns an outbound record", async () => {
    const result = await send({
      config,
      space: { id: "99" },
      content: await text("hello").build(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      `${config.baseUrl}/2/dm_conversations/with/99/messages`
    );
    expect(calls[0]?.authorization).toBe(`Bearer ${config.accessToken}`);
    expect(calls[0]?.body).toEqual({ text: "hello" });

    expect(result).toMatchObject({
      id: "evt-1",
      direction: "outbound",
      content: { type: "text", text: "hello" },
      space: { id: "42:99" },
    });
    expect(result?.timestamp).toBeInstanceOf(Date);
  });

  it("resolves recipient id from an internal conversation id space", async () => {
    await send({
      config,
      space: { id: "42:99" },
      content: await text("from conversation").build(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${config.baseUrl}/2/dm_conversations/with/99/messages`
    );
  });

  it("throws when a conversation id does not include the configured xUserId", async () => {
    await expect(
      send({
        config,
        space: { id: "1:2" },
        content: await text("nope").build(),
      })
    ).rejects.toThrow("not associated");
    expect(calls).toHaveLength(0);
  });

  it("rejects unsupported content types in v1", async () => {
    await expect(
      send({
        config,
        space: { id: "99" },
        content: await markdown("**hello**").build(),
      })
    ).rejects.toThrow('does not support content type "markdown"');
    expect(calls).toHaveLength(0);
  });
});
