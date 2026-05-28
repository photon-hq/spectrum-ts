import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { lookup as lookupMimeType } from "mime-types";
import z from "zod";
import {
  bufferToStream,
  fetchUrlBytes,
  readSchema,
  streamSchema,
} from "../utils/io";
import type { ContentBuilder } from "./types";

const DEFAULT_ATTACHMENT_NAME = "attachment";

export const attachmentSchema = z.object({
  type: z.literal("attachment"),
  name: z.string().nonempty(),
  mimeType: z.string().nonempty(),
  size: z.number().int().nonnegative().optional(),
  read: readSchema,
  stream: streamSchema,
});

export type Attachment = z.infer<typeof attachmentSchema>;

export type AttachmentInput = string | Buffer | URL;

const resolveAttachmentName = (
  input: AttachmentInput,
  name?: string
): string => {
  if (name) {
    return name;
  }
  if (input instanceof URL) {
    return basename(input.pathname) || DEFAULT_ATTACHMENT_NAME;
  }
  if (typeof input === "string") {
    return basename(input);
  }
  return DEFAULT_ATTACHMENT_NAME;
};

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
  input: AttachmentInput,
  options?: { mimeType?: string; name?: string }
): ContentBuilder {
  return {
    build: async () => {
      const name = resolveAttachmentName(input, options?.name);
      const mimeType = resolveAttachmentMimeType(name, options?.mimeType);

      if (input instanceof URL) {
        return asAttachment({
          name,
          mimeType,
          read: async () => (await fetchUrlBytes(input)).data,
        });
      }

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
