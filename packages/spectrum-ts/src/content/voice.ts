import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { lookup as lookupMimeType } from "mime-types";
import z from "zod";
import type { ContentBuilder } from "./types";

const readSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(Buffer)),
});

const streamSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(ReadableStream)),
});

export const voiceSchema = z.object({
  type: z.literal("voice"),
  name: z.string().nonempty().optional(),
  mimeType: z.string().nonempty(),
  duration: z.number().nonnegative().optional(),
  size: z.number().int().nonnegative().optional(),
  read: readSchema,
  stream: streamSchema,
});

export type Voice = z.infer<typeof voiceSchema>;

const resolveVoiceName = (
  input: string | Buffer,
  name?: string
): string | undefined => {
  if (name) {
    return name;
  }
  if (typeof input === "string") {
    return basename(input);
  }
  return undefined;
};

const resolveVoiceMimeType = (
  name: string | undefined,
  mimeType?: string
): string => {
  if (mimeType) {
    return mimeType;
  }
  if (name) {
    const resolved = lookupMimeType(name);
    if (resolved) {
      return resolved;
    }
  }
  throw new Error(
    "Unable to resolve MIME type for voice content. Pass options.mimeType explicitly."
  );
};

const bufferToStream = (buf: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });

export const asVoice = (input: {
  name?: string;
  mimeType: string;
  duration?: number;
  size?: number;
  read: () => Promise<Buffer>;
  stream?: () => Promise<ReadableStream<Uint8Array>>;
}): Voice => {
  let cached: Promise<Buffer> | undefined;
  const read = (): Promise<Buffer> => {
    cached ??= input.read().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
    return cached;
  };

  const stream = input.stream ?? (async () => bufferToStream(await read()));

  return voiceSchema.parse({
    type: "voice",
    name: input.name,
    mimeType: input.mimeType,
    duration: input.duration,
    size: input.size,
    read,
    stream,
  });
};

export function voice(
  input: string | Buffer,
  options?: { mimeType?: string; name?: string; duration?: number }
): ContentBuilder {
  return {
    build: async () => {
      const name = resolveVoiceName(input, options?.name);
      const mimeType = resolveVoiceMimeType(name, options?.mimeType);

      if (typeof input === "string") {
        const stats = await stat(input);
        return asVoice({
          name,
          mimeType,
          duration: options?.duration,
          size: stats.size,
          read: () => readFile(input),
          stream: async () =>
            Readable.toWeb(
              createReadStream(input)
            ) as ReadableStream<Uint8Array>,
        });
      }

      return asVoice({
        name,
        mimeType,
        duration: options?.duration,
        size: input.byteLength,
        read: async () => input,
        stream: async () => bufferToStream(input),
      });
    },
  };
}
