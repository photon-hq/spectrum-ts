import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { asAttachment } from "@/content/attachment";
import { asGroup } from "@/content/group";
import { asText, text } from "@/content/text";
import { createCloudAuth } from "@/providers/x/auth";
import { configSchema, directConfigSchema } from "@/providers/x/config";
import { send } from "@/providers/x/outbound/send";
import { cloud } from "@/utils/cloud";
import { createStore } from "@/utils/store";

interface CapturedCall {
  authorization: string | null;
  body?: Record<string, unknown>;
  method: string;
  url: string;
}

const config = directConfigSchema.parse({
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  xUserId: "42",
  appBearerToken: "app-bearer-token",
});

const store = createStore();

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
      // Chunked media upload endpoint: INIT/APPEND/FINALIZE all hit the same URL
      // with a multipart body. Return a media id so the DM can attach it.
      if (request.url.includes("/2/media/upload")) {
        return Response.json({ data: { id: "media-xyz" } });
      }
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
      store,
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
      store,
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
        store,
        space: { id: "1:2" },
        content: await text("nope").build(),
      })
    ).rejects.toThrow("not associated");
    expect(calls).toHaveLength(0);
  });

  it("rejects unsupported content types in v1", async () => {
    const { markdown } = await import("@/content/markdown");
    await expect(
      send({
        config,
        store,
        space: { id: "99" },
        content: await markdown("**hello**").build(),
      })
    ).rejects.toThrow('does not support content type "markdown"');
    expect(calls).toHaveLength(0);
  });

  it("uses cloud credentials from the platform store", async () => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue({
      auth: { "42": "cloud-access-token" },
      accounts: { a: { xUserId: "42" } },
      consumerSecret: "cloud-consumer-secret",
      expiresIn: 900,
    });

    const cloudStore = createStore();
    await createCloudAuth({
      projectId: "proj",
      projectSecret: "secret",
      store: cloudStore,
    });

    await send({
      config: configSchema.parse({}),
      store: cloudStore,
      space: { id: "99" },
      content: await text("cloud hello").build(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer cloud-access-token");
  });

  const imageAttachment = () =>
    asAttachment({
      id: "att-1",
      name: "pic.png",
      mimeType: "image/png",
      read: async () => Buffer.from("img-bytes"),
    });

  // Group items are minimal `{ id, content }` stubs (as the send path reads
  // `item.content` only); cast to satisfy the Message type.
  const stub = (id: string, content: unknown) =>
    ({ id, content }) as unknown as Parameters<typeof asGroup>[0]["items"][0];

  it("uploads a bare attachment and sends a media DM", async () => {
    const result = await send({
      config,
      store,
      space: { id: "99" },
      content: imageAttachment(),
    });

    expect(calls.some((c) => c.url.includes("/2/media/upload"))).toBe(true);
    const dmCall = calls.find((c) => c.url.endsWith("/messages"));
    expect(dmCall?.body).toEqual({ attachments: [{ media_id: "media-xyz" }] });
    expect(dmCall?.authorization).toBe(`Bearer ${config.accessToken}`);
    expect(result).toMatchObject({
      id: "evt-1",
      direction: "outbound",
      space: { id: "42:99" },
    });
  });

  it("sends a group of caption + attachment as a single DM with text and media", async () => {
    await send({
      config,
      store,
      space: { id: "99" },
      content: asGroup({
        items: [stub("0", asText("caption")), stub("1", imageAttachment())],
      }),
    });

    const dmCall = calls.find((c) => c.url.endsWith("/messages"));
    expect(dmCall?.body).toEqual({
      attachments: [{ media_id: "media-xyz" }],
      text: "caption",
    });
  });

  it("rejects a group with more than one attachment", async () => {
    await expect(
      send({
        config,
        store,
        space: { id: "99" },
        content: asGroup({
          items: [stub("0", imageAttachment()), stub("1", imageAttachment())],
        }),
      })
    ).rejects.toThrow("only one media attachment");
  });
});
