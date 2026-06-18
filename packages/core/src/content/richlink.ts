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

/**
 * Pre-supplied link metadata — used when the platform already unfurled the
 * link (e.g. the chat-SDK delivers title/description/imageUrl on inbound
 * messages), so constructing the richlink must NOT trigger a network fetch.
 * Distinguished from the URL-only form by the presence of any metadata key.
 */
export interface RichlinkMetadataInput {
  cover?: { imageUrl: string; mimeType?: string };
  summary?: string;
  title?: string;
  url: string;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

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
const isPrefetched = (
  input: { url: string } | RichlinkMetadataInput
): input is RichlinkMetadataInput =>
  "title" in input || "summary" in input || "cover" in input;

// Build a richlink from metadata the platform already supplied, never
// touching the network. Empty strings are normalised to `undefined` to match
// the schema's non-empty constraint and the lazy path's `cleanString`.
const richlinkFromMetadata = (input: RichlinkMetadataInput): Richlink => {
  const cover = input.cover
    ? buildCover({ url: input.cover.imageUrl, mimeType: input.cover.mimeType })
    : undefined;
  const title = clean(input.title);
  const summary = clean(input.summary);
  return richlinkSchema.parse({
    type: "richlink",
    url: input.url,
    title: () => Promise.resolve(title),
    summary: () => Promise.resolve(summary),
    cover: () => Promise.resolve(cover),
  });
};

/**
 * Construct a `richlink` content value.
 *
 * Two forms:
 * - `asRichlink({ url })` — accessors (`title`, `summary`, `cover`) are async
 *   and lazy: the first call issues a single network request to the URL;
 *   subsequent calls share the cached result. Network / parse failures resolve
 *   to `undefined` and are cached — no retries. Callers who only need `title` /
 *   `summary` never trigger an image download; calling `cover.read()` triggers
 *   one additional request to fetch the image bytes.
 * - `asRichlink({ url, title?, summary?, cover? })` — when the platform already
 *   unfurled the link, the supplied metadata is used as-is and no network
 *   request is ever made (accessors resolve the provided values; `cover.read()`
 *   still fetches the image bytes lazily from `cover.imageUrl`).
 */
export const asRichlink = (
  input: { url: string } | RichlinkMetadataInput
): Richlink => {
  if (isPrefetched(input)) {
    return richlinkFromMetadata(input);
  }

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
