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
import { uploadDmMedia } from "@/providers/x/outbound/media";

const config = { accessToken: "access-token", baseUrl: "https://api.x.com" };

interface CapturedCall {
  command?: string;
  mediaCategory?: string;
  mediaType?: string;
  segmentIndex?: string;
  totalBytes?: string;
  url: string;
}

const makeAttachment = (mimeType: string, bytes: Buffer) =>
  asAttachment({
    id: "att-1",
    name: `file.${mimeType.split("/")[1]}`,
    mimeType,
    read: async () => bytes,
  });

let calls: CapturedCall[];
// Per-test override for what FINALIZE / STATUS return.
let finalizeResponse: Record<string, unknown>;
let statusResponses: Record<string, unknown>[];

const installFetch = () => {
  const impl = (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> =>
    (async (): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      let command = url.searchParams.get("command") ?? undefined;
      const captured: CapturedCall = { url: request.url };
      if (request.method === "POST") {
        const form = await request.clone().formData();
        command = (form.get("command") as string | null) ?? command;
        captured.mediaCategory =
          (form.get("media_category") as string | null) ?? undefined;
        captured.mediaType =
          (form.get("media_type") as string | null) ?? undefined;
        captured.segmentIndex =
          (form.get("segment_index") as string | null) ?? undefined;
        captured.totalBytes =
          (form.get("total_bytes") as string | null) ?? undefined;
      }
      captured.command = command;
      calls.push(captured);

      if (command === "INIT") {
        return Response.json({ data: { id: "media-123" } });
      }
      if (command === "FINALIZE") {
        return Response.json(finalizeResponse);
      }
      if (command === "STATUS") {
        return Response.json(statusResponses.shift() ?? {});
      }
      // APPEND
      return Response.json({});
    })();
  spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch
  );
};

beforeEach(() => {
  calls = [];
  finalizeResponse = { data: { id: "media-123" } };
  statusResponses = [];
  installFetch();
});

afterEach(() => {
  mock.restore();
});

describe("x media upload", () => {
  it("runs INIT/APPEND/FINALIZE for an image and returns the media id", async () => {
    const mediaId = await uploadDmMedia(
      config,
      makeAttachment("image/png", Buffer.from("small-image"))
    );

    expect(mediaId).toBe("media-123");
    expect(calls.map((c) => c.command)).toEqual(["INIT", "APPEND", "FINALIZE"]);
    expect(calls[0]?.mediaCategory).toBe("dm_image");
    expect(calls[0]?.mediaType).toBe("image/png");
    expect(calls[0]?.totalBytes).toBe(String("small-image".length));
    expect(calls[0]?.url).toBe("https://api.x.com/2/media/upload");
  });

  it("maps gif and video MIME types to their DM categories", async () => {
    await uploadDmMedia(config, makeAttachment("image/gif", Buffer.from("g")));
    expect(calls[0]?.mediaCategory).toBe("dm_gif");

    calls = [];
    finalizeResponse = { data: { id: "media-123" } };
    await uploadDmMedia(config, makeAttachment("video/mp4", Buffer.from("v")));
    expect(calls[0]?.mediaCategory).toBe("dm_video");
  });

  it("splits large payloads into 1 MB APPEND segments", async () => {
    const bytes = Buffer.alloc(1024 * 1024 * 2 + 10, 1); // 2 MB + 10 bytes => 3 chunks
    await uploadDmMedia(config, makeAttachment("video/mp4", bytes));

    const appends = calls.filter((c) => c.command === "APPEND");
    expect(appends.map((c) => c.segmentIndex)).toEqual(["0", "1", "2"]);
  });

  it("polls STATUS until processing succeeds", async () => {
    finalizeResponse = {
      data: {
        id: "media-123",
        processing_info: { state: "pending", check_after_secs: 0 },
      },
    };
    statusResponses = [
      {
        data: {
          processing_info: { state: "in_progress", check_after_secs: 0 },
        },
      },
      { data: { processing_info: { state: "succeeded" } } },
    ];

    const mediaId = await uploadDmMedia(
      config,
      makeAttachment("video/mp4", Buffer.from("v"))
    );

    expect(mediaId).toBe("media-123");
    expect(calls.filter((c) => c.command === "STATUS")).toHaveLength(2);
  });

  it("throws when processing fails", async () => {
    finalizeResponse = {
      data: {
        id: "media-123",
        processing_info: { state: "failed", error: { message: "bad codec" } },
      },
    };

    await expect(
      uploadDmMedia(config, makeAttachment("video/mp4", Buffer.from("v")))
    ).rejects.toThrow("bad codec");
  });

  it("rejects unsupported MIME types before uploading", async () => {
    await expect(
      uploadDmMedia(
        config,
        makeAttachment("application/pdf", Buffer.from("%PDF"))
      )
    ).rejects.toThrow('does not support content type "attachment"');
    expect(calls).toHaveLength(0);
  });
});
