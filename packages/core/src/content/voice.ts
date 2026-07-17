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

const AUDIO_MIME_PATTERN = /^audio\//i;

const audioMimeSchema = z
  .string()
  .nonempty()
  .regex(AUDIO_MIME_PATTERN, "voice content requires an audio/* MIME type");

export const voiceSchema = z.object({
  type: z.literal("voice"),
  id: z.string().nonempty().optional(),
  name: z.string().nonempty().optional(),
  mimeType: audioMimeSchema,
  duration: z.number().nonnegative().optional(),
  size: z.number().int().nonnegative().optional(),
  read: readSchema,
  stream: streamSchema,
});

export type Voice = z.infer<typeof voiceSchema>;

export type VoiceInput = string | Buffer | URL;

const resolveVoiceName = (
  input: VoiceInput,
  name?: string
): string | undefined => {
  if (name) {
    return name;
  }
  if (input instanceof URL) {
    return basename(input.pathname) || undefined;
  }
  if (typeof input === "string") {
    return basename(input);
  }
  return;
};

const resolveVoiceMimeHint = (
  input: VoiceInput,
  name: string | undefined
): string | undefined => {
  if (input instanceof URL) {
    return basename(input.pathname) || undefined;
  }
  if (typeof input === "string") {
    return basename(input);
  }
  return name;
};

const resolveVoiceMimeType = (
  name: string | undefined,
  mimeType?: string
): string => {
  if (mimeType) {
    if (!AUDIO_MIME_PATTERN.test(mimeType)) {
      throw new Error(
        `voice content requires an audio/* MIME type, got "${mimeType}".`
      );
    }
    return mimeType;
  }
  if (name) {
    const resolved = lookupMimeType(name);
    if (resolved && AUDIO_MIME_PATTERN.test(resolved)) {
      return resolved;
    }
    if (resolved) {
      throw new Error(
        `Resolved non-audio MIME type "${resolved}" from name "${name}". Pass options.mimeType explicitly with an audio/* type.`
      );
    }
  }
  throw new Error(
    "Unable to resolve MIME type for voice content. Pass options.mimeType explicitly."
  );
};

export const asVoice = (input: {
  id?: string;
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
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    mimeType: input.mimeType,
    duration: input.duration,
    size: input.size,
    read,
    stream,
  });
};

export function voice(
  input: VoiceInput,
  options?: { mimeType?: string; name?: string; duration?: number }
): ContentBuilder {
  return {
    build: async () => {
      const name = resolveVoiceName(input, options?.name);
      const mimeHint = resolveVoiceMimeHint(input, name);
      const mimeType = resolveVoiceMimeType(mimeHint, options?.mimeType);

      if (input instanceof URL) {
        return asVoice({
          name,
          mimeType,
          duration: options?.duration,
          read: async () => (await fetchUrlBytes(input)).data,
        });
      }

      if (typeof input === "string") {
        const stats = await stat(input);
        if (!stats.isFile()) {
          throw new Error(
            `voice content path "${input}" is not a regular file.`
          );
        }
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
