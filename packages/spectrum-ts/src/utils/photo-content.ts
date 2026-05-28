import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import z from "zod";
import { fetchUrlBytes, readSchema } from "./io";

/**
 * Shared building blocks for photo-style content (chat background, group
 * avatar/icon, …) whose builders all share the same `set | clear` shape and
 * the same `"clear"` reserved-string sentinel.
 *
 * Keeping the action schema and `buildPhotoAction` factory here means both
 * `background()` and `avatar()` parse against the same structural definition
 * and any DX fix (mime inference, read caching, sentinel docs) lands once.
 */

export const CLEAR_SENTINEL = "clear" as const;

export type PhotoInput = typeof CLEAR_SENTINEL | string | Buffer | URL;

export const photoActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set"),
    read: readSchema,
    mimeType: z.string().nonempty(),
  }),
  z.object({ kind: z.literal("clear") }),
]);

export type PhotoAction = z.infer<typeof photoActionSchema>;

const resolveMimeType = (
  input: string | Buffer | URL,
  mimeType: string | undefined,
  contentLabel: string
): string => {
  if (mimeType) {
    return mimeType;
  }
  if (input instanceof URL) {
    const resolved = lookupMimeType(basename(input.pathname));
    if (resolved) {
      return resolved;
    }
  } else if (typeof input === "string") {
    const resolved = lookupMimeType(basename(input));
    if (resolved) {
      return resolved;
    }
  }
  throw new Error(
    `Unable to resolve MIME type for ${contentLabel}. Pass options.mimeType explicitly.`
  );
};

const cachedRead = (read: () => Promise<Buffer>): (() => Promise<Buffer>) => {
  let cached: Promise<Buffer> | undefined;
  return () => {
    cached ??= read().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
    return cached;
  };
};

/**
 * Convert a photo-content input into the discriminated `PhotoAction` shape.
 *
 * - `"clear"` → `{ kind: "clear" }` (reserved sentinel — to send a literal
 *   file named `clear`, pass `"./clear"` or load it as a `Buffer`).
 * - `string` path → reads the file lazily via `node:fs/promises.readFile`;
 *   MIME type inferred from the filename extension.
 * - `URL` → fetched lazily over the network into memory; never touches the
 *   filesystem, so it works in read-only environments. MIME type is inferred
 *   from the URL pathname extension at build time (override with
 *   `options.mimeType` if the URL has no usable extension).
 * - `Buffer` → in-memory bytes; `options.mimeType` is required.
 *
 * Called at builder-construction time so a missing MIME type fails fast
 * rather than at send time. The returned `read()` is memoized so repeated
 * `build()` / send cycles don't re-read the same file.
 */
export const buildPhotoAction = (
  input: PhotoInput,
  options: { mimeType?: string } | undefined,
  contentLabel: string
): PhotoAction => {
  if (input === CLEAR_SENTINEL) {
    return { kind: "clear" };
  }
  const mimeType = resolveMimeType(input, options?.mimeType, contentLabel);
  let read: () => Promise<Buffer>;
  if (input instanceof URL) {
    read = cachedRead(async () => (await fetchUrlBytes(input)).data);
  } else if (typeof input === "string") {
    read = cachedRead(() => readFile(input));
  } else {
    // Snapshot the bytes at builder-construction time so callers can safely
    // mutate or reuse their Buffer after building (the cached read would
    // otherwise surface any later writes through the same reference).
    const snapshot = Buffer.from(input);
    read = cachedRead(async () => snapshot);
  }
  return { kind: "set", read, mimeType };
};
