import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { lookup as lookupMimeType } from "mime-types";
import z from "zod";
import type { ContentBuilder } from "./types";

const DEFAULT_ATTACHMENT_NAME = "attachment";

const readSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(Buffer)),
});

const streamSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(ReadableStream)),
});

export const attachmentSchema = z.object({
  type: z.literal("attachment"),
  name: z.string().nonempty(),
  mimeType: z.string().nonempty(),
  size: z.number().int().nonnegative().optional(),
  read: readSchema,
  stream: streamSchema,
});

export type Attachment = z.infer<typeof attachmentSchema>;

const resolveAttachmentName = (input: string | Buffer, name?: string): string =>
  name ||
  (typeof input === "string" ? basename(input) : DEFAULT_ATTACHMENT_NAME);

const resolveAttachmentMimeType = (name: string, mimeType?: string): string => {
  if (mimeType) {
    return mimeType;
  }

  const resolvedMimeType = lookupMimeType(name);
  if (!resolvedMimeType) {
    throw new Error(
      `Unable to resolve MIME type for attachment "${name}". Pass options.mimeType explicitly.`
    );
  }

  return resolvedMimeType;
};

const bufferToStream = (buf: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });

export const asAttachment = (input: {
  name: string;
  mimeType: string;
  size?: number;
  read: () => Promise<Buffer>;
  stream?: () => Promise<ReadableStream<Uint8Array>>;
}): Attachment => {
  let cached: Promise<Buffer> | undefined;
  const read = (): Promise<Buffer> => {
    cached ??= input.read().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
    return cached;
  };

  const stream = input.stream ?? (async () => bufferToStream(await read()));

  return attachmentSchema.parse({
    type: "attachment",
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    read,
    stream,
  });
};

export function attachment(
  input: string | Buffer,
  options?: { mimeType?: string; name?: string }
): ContentBuilder {
  return {
    build: async () => {
      const name = resolveAttachmentName(input, options?.name);
      const mimeType = resolveAttachmentMimeType(name, options?.mimeType);

      if (typeof input === "string") {
        const stats = await stat(input);
        return asAttachment({
          name,
          mimeType,
          size: stats.size,
          read: () => readFile(input),
          stream: async () =>
            Readable.toWeb(
              createReadStream(input)
            ) as ReadableStream<Uint8Array>,
        });
      }

      return asAttachment({
        name,
        mimeType,
        size: input.byteLength,
        read: async () => input,
        stream: async () => bufferToStream(input),
      });
    },
  };
}
