import z from "zod";
import { bufferToStream, readSchema, streamSchema } from "../utils/io";
import {
  fetchImage,
  fetchLinkMetadata,
  type LinkMetadata,
} from "../utils/link-metadata";
import type { ContentBuilder } from "./types";

const richlinkCoverSchema = z.object({
  mimeType: z.string().min(1).optional(),
  read: readSchema,
  stream: streamSchema,
});

const optionalStringAccessor = z.function({
  input: [],
  output: z.promise(z.string().min(1).optional()),
});

const coverAccessor = z.function({
  input: [],
  output: z.promise(richlinkCoverSchema.optional()),
});

export const richlinkSchema = z.object({
  type: z.literal("richlink"),
  url: z.url(),
  title: optionalStringAccessor,
  summary: optionalStringAccessor,
  cover: coverAccessor,
});

export type Richlink = z.infer<typeof richlinkSchema>;
export type RichlinkCover = z.infer<typeof richlinkCoverSchema>;

const memoize = <T>(factory: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= factory();
    return cached;
  };
};

const buildCover = (
  image: NonNullable<LinkMetadata["image"]>
): RichlinkCover => {
  const read = memoize(() =>
    fetchImage(image.url)
      .then((r) => r.data)
      .catch(() => Buffer.alloc(0))
  );
  return {
    mimeType: image.mimeType,
    read,
    stream: async () => bufferToStream(await read()),
  };
};

/**
 * Construct a `richlink` content value.
 *
 * Accessors (`title`, `summary`, `cover`) are async and lazy: the first call
 * issues a single network request to the URL; subsequent calls share the
 * cached result. Network / parse failures resolve to `undefined` and are
 * cached — no retries. Callers who only need `title` / `summary` never
 * trigger an image download; calling `cover.read()` triggers one additional
 * request to fetch the image bytes.
 */
export const asRichlink = (input: { url: string }): Richlink => {
  const getMetadata = memoize(() => fetchLinkMetadata(input.url));
  const getCover = memoize(async (): Promise<RichlinkCover | undefined> => {
    const { image } = await getMetadata();
    return image ? buildCover(image) : undefined;
  });

  const title = async () => (await getMetadata()).title;
  const summary = async () => (await getMetadata()).summary;

  return richlinkSchema.parse({
    type: "richlink",
    url: input.url,
    title,
    summary,
    cover: getCover,
  });
};

export function richlink(url: string): ContentBuilder {
  return {
    build: async () => asRichlink({ url }),
  };
}
