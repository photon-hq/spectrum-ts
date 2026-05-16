import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import z from "zod";
import type { Content, ContentBuilder } from "../../../content/types";
import { readSchema } from "../../../utils/io";

/**
 * iMessage-only chat background content. Lives entirely under the iMessage
 * provider — never enters the universal `Content` discriminated union. The
 * framework recognizes it via two generic content-level contracts:
 *
 * 1. `__platform: "iMessage"` — `findUnsupportedPlatformContent` in
 *    `platform/build.ts` reads this tag and warns-and-skips when a different
 *    platform receives it.
 * 2. `__fireAndForget: true` — `dispatchSend`'s fire-and-forget check
 *    treats this as a side-effecting send that returns no message id, the
 *    same way it treats `reaction` / `typing` / `edit`.
 *
 * iMessage's `send` handler narrows back to `Background` via the `isBackground`
 * type guard before dispatching to `chats.setBackground` / `removeBackground`.
 */
const backgroundActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set"),
    read: readSchema,
    mimeType: z.string().nonempty(),
  }),
  z.object({ kind: z.literal("clear") }),
]);

export const backgroundSchema = z.object({
  type: z.literal("background"),
  __platform: z.literal("iMessage"),
  __fireAndForget: z.literal(true),
  action: backgroundActionSchema,
});

export type Background = z.infer<typeof backgroundSchema>;

export const isBackground = (v: unknown): v is Background =>
  backgroundSchema.safeParse(v).success;

const CLEAR_SENTINEL = "clear" as const;
export type BackgroundInput = typeof CLEAR_SENTINEL | string | Buffer;

const resolveMimeType = (input: string | Buffer, mimeType?: string): string => {
  if (mimeType) {
    return mimeType;
  }
  if (typeof input === "string") {
    const resolved = lookupMimeType(basename(input));
    if (resolved) {
      return resolved;
    }
  }
  throw new Error(
    "Unable to resolve MIME type for background. Pass options.mimeType explicitly."
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
 * Set or clear the chat background. iMessage-only, remote-only.
 *
 * - `background("clear")` — remove the current chat background.
 * - `background("./photo.jpg")` — set background from a filesystem path.
 *   MIME type is inferred from the extension; override with `options.mimeType`.
 * - `background(buffer, { mimeType })` — set background from in-memory bytes.
 *   `options.mimeType` is required.
 *
 * `"clear"` is a reserved string-literal sentinel. If you have a file literally
 * named `clear` with no extension, pass `"./clear"` or load it as a Buffer.
 *
 * `space.send(background(...))` is the canonical form; `space.background(...)`
 * is sugar attached via `PlatformDef.space.actions` (only typed on
 * `PlatformSpace<IMessageDef>`).
 *
 * `Background` is intentionally not a member of the universal `Content`
 * union — the `as unknown as Content` cast keeps the builder shape compatible
 * with the framework's `ContentBuilder.build(): Promise<Content>` signature.
 * The framework treats it as a fire-and-forget control signal at runtime.
 */
export function background(input: "clear"): ContentBuilder;
export function background(
  input: string | Buffer,
  options?: { mimeType?: string }
): ContentBuilder;
export function background(
  input: BackgroundInput,
  options?: { mimeType?: string }
): ContentBuilder {
  if (input === CLEAR_SENTINEL) {
    return {
      build: async () =>
        backgroundSchema.parse({
          type: "background",
          __platform: "iMessage",
          __fireAndForget: true,
          action: { kind: "clear" },
        }) as unknown as Content,
    };
  }
  // Snapshot the reader and MIME type at builder construction so that
  // (a) re-invoking `build()` reuses the same cached read and (b) a missing
  // MIME type fails fast rather than at send time.
  const mimeType = resolveMimeType(input, options?.mimeType);
  const read =
    typeof input === "string"
      ? cachedRead(() => readFile(input))
      : cachedRead(async () => input);
  return {
    build: async () =>
      backgroundSchema.parse({
        type: "background",
        __platform: "iMessage",
        __fireAndForget: true,
        action: { kind: "set", read, mimeType },
      }) as unknown as Content,
  };
}
