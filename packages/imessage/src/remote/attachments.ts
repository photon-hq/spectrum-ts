import {
  type AdvancedIMessage,
  NotFoundError,
} from "@photon-ai/advanced-imessage/grpc";
import type { Attachment } from "@spectrum-ts/core";
import { asAttachment } from "@spectrum-ts/core/authoring";
import { normalizeAppleAttachmentMimeType } from "../shared/audio";

/**
 * Stream the primary file bytes of an attachment as a `ReadableStream`.
 * Skips header and Live Photo companion frames; emits only `primaryChunk`
 * payloads. Cleans up the underlying gRPC iterator on cancel and on error.
 */
export const downloadPrimaryAttachmentStream = (
  client: AdvancedIMessage,
  attachmentGuid: string
): ReadableStream<Uint8Array> => {
  const frames = client.attachments.downloadStream(attachmentGuid);
  const iterator = frames[Symbol.asyncIterator]();
  let closed = false;

  const closeFrames = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await iterator.return?.();
    } finally {
      await frames.close();
    }
  };

  return new ReadableStream<Uint8Array>({
    async cancel() {
      await closeFrames();
    },
    async pull(controller) {
      try {
        while (true) {
          const result = await iterator.next();
          if (result.done) {
            controller.close();
            await closeFrames();
            return;
          }
          if (result.value.type === "primaryChunk") {
            controller.enqueue(result.value.data);
            return;
          }
        }
      } catch (error) {
        await closeFrames();
        throw error;
      }
    },
  });
};

/**
 * Collect the primary file bytes of an attachment into a single `Buffer`.
 * Skips header and Live Photo companion frames.
 */
export const downloadPrimaryAttachment = async (
  client: AdvancedIMessage,
  attachmentGuid: string
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const frames = client.attachments.downloadStream(attachmentGuid);
  try {
    for await (const frame of frames) {
      if (frame.type === "primaryChunk") {
        chunks.push(Buffer.from(frame.data));
      }
    }
  } finally {
    await frames.close();
  }
  return Buffer.concat(chunks);
};

/**
 * Fetch an attachment by GUID and wrap it as a spectrum `Attachment`. The
 * returned object is lazy: `.read()` triggers a Buffer download, `.stream()`
 * opens a fresh byte stream. Calling both issues two independent gRPC
 * downloads — cache `.read()` if you need the bytes more than once.
 *
 * Returns `undefined` when the GUID is unknown to the server.
 */
export const getRemoteAttachment = async (
  client: AdvancedIMessage,
  guid: string
): Promise<Attachment | undefined> => {
  let info: Awaited<ReturnType<AdvancedIMessage["attachments"]["get"]>>;
  try {
    info = await client.attachments.get(guid);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return;
    }
    throw err;
  }
  return asAttachment({
    id: info.guid,
    name: info.fileName,
    mimeType: normalizeAppleAttachmentMimeType(info),
    size: info.totalBytes,
    read: () => downloadPrimaryAttachment(client, info.guid),
    stream: async () => downloadPrimaryAttachmentStream(client, info.guid),
  });
};
