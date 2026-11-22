import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { send } from "@/remote/send";

const TRANSCODED = Buffer.from("m4a-bytes");

vi.mock("@spectrum-ts/core/authoring", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@spectrum-ts/core/authoring")>();
  return {
    ...actual,
    // Stand-in for ffmpeg: non-M4A sources come back as a new buffer.
    ensureM4a: (buffer: Buffer, mimeType: string) =>
      Promise.resolve(
        mimeType === "audio/mp4" ? { buffer } : { buffer: TRANSCODED }
      ),
  };
});

const makeRemote = () => {
  const upload = vi.fn((_input: { data: Buffer; fileName: string }) =>
    Promise.resolve({ attachment: { guid: "att-guid" } })
  );
  const sendAttachment = vi.fn(() =>
    Promise.resolve({ guid: "msg-guid", dateCreated: new Date(0) })
  );
  const remote = {
    messages: { sendAttachment },
    attachments: { upload },
  } as unknown as AdvancedIMessage;
  return { remote, upload };
};

const voiceOf = (name: string | undefined, mimeType: string) =>
  ({
    type: "voice",
    name,
    mimeType,
    read: () => Promise.resolve(Buffer.from("source-bytes")),
  }) as unknown as Content;

describe("send (voice)", () => {
  it("renames a transcoded upload to .m4a", async () => {
    const { remote, upload } = makeRemote();

    await send(remote, "chat", voiceOf("memo.mp3", "audio/mpeg"));

    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      data: TRANSCODED,
      fileName: "memo.m4a",
    });
  });

  it("keeps the name when the source is already M4A", async () => {
    const { remote, upload } = makeRemote();

    await send(remote, "chat", voiceOf("memo.m4a", "audio/mp4"));

    expect(upload.mock.calls[0]?.[0]).toMatchObject({ fileName: "memo.m4a" });
  });

  it("uses voice.m4a when the source has no name", async () => {
    const { remote, upload } = makeRemote();

    await send(remote, "chat", voiceOf(undefined, "audio/mpeg"));

    expect(upload.mock.calls[0]?.[0]).toMatchObject({ fileName: "voice.m4a" });
  });
});
