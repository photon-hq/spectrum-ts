import z from "zod";
import type { Content, ContentBuilder } from "../../../content/types";
import {
  buildPhotoAction,
  type PhotoInput,
  photoActionSchema,
} from "../../../utils/photo-content";

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
export const backgroundSchema = z.object({
  type: z.literal("background"),
  __platform: z.literal("iMessage"),
  __fireAndForget: z.literal(true),
  action: photoActionSchema,
});

export type Background = z.infer<typeof backgroundSchema>;

export const isBackground = (v: unknown): v is Background =>
  backgroundSchema.safeParse(v).success;

export type BackgroundInput = PhotoInput;

/**
 * Set or clear the chat background. iMessage-only, remote-only.
 *
 * - `background("clear")` — remove the current chat background.
 * - `background("./photo.jpg")` — set background from a filesystem path.
 *   MIME type is inferred from the extension; override with `options.mimeType`.
 * - `background(new URL("https://…/photo.jpg"))` — fetch the background
 *   lazily over the network. Bytes stay in memory (safe in read-only
 *   environments). MIME type is inferred from the URL pathname extension;
 *   override with `options.mimeType` when the URL has no usable extension.
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
  input: string | Buffer | URL,
  options?: { mimeType?: string }
): ContentBuilder;
export function background(
  input: BackgroundInput,
  options?: { mimeType?: string }
): ContentBuilder {
  // Snapshot the action at builder construction so (a) a missing MIME type
  // fails fast and (b) the read is cached across repeated `build()` calls.
  const action = buildPhotoAction(input, options, "background");
  return {
    build: async () =>
      backgroundSchema.parse({
        type: "background",
        __platform: "iMessage",
        __fireAndForget: true,
        action,
      }) as unknown as Content,
  };
}
