import z from "zod";
import {
  buildPhotoAction,
  type PhotoInput,
  photoActionSchema,
} from "../utils/photo-content";
import type { ContentBuilder } from "./types";

/**
 * Set or clear the chat avatar (group icon). Universal content — providers
 * dispatch by `content.type === "avatar"` in their `send` action and decide
 * their own support story (e.g. iMessage only supports it for remote group
 * chats).
 *
 * `space.send(avatar(...))` is the canonical form; `space.avatar(...)` is
 * universal sugar that delegates here. Per-platform constraints (e.g.
 * group-only, remote-only) surface as `UnsupportedError` from the provider's
 * `send` action so the canonical and sugar forms share one error path.
 *
 * Bidirectional: providers also surface platform icon changes as inbound
 * `Message`s carrying this content — `action.kind === "set"` arrives with
 * the fetched icon behind `read()`, `"clear"` mirrors icon removal.
 * `message.sender` is the user who changed it (may be `undefined` when the
 * platform recorded no actor).
 */
export const avatarSchema = z.object({
  type: z.literal("avatar"),
  action: photoActionSchema,
});

export type Avatar = z.infer<typeof avatarSchema>;

export type AvatarInput = PhotoInput;

/**
 * The current chat avatar as returned by `space.getAvatar()`: raw image bytes
 * plus MIME type. `data` is a Buffer so the value round-trips into the
 * setter — `space.avatar(res.data, { mimeType: res.mimeType })`.
 */
export interface AvatarData {
  data: Buffer;
  mimeType: string;
}

/**
 * Build an `Avatar` content value.
 *
 * - `avatar("clear")` — remove the current chat avatar.
 * - `avatar("./icon.png")` — set avatar from a filesystem path. MIME type is
 *   inferred from the extension; override with `options.mimeType`.
 * - `avatar(new URL("https://…/icon.png"))` — fetch the avatar lazily over
 *   the network. Bytes stay in memory (safe in read-only environments). MIME
 *   type is inferred from the URL pathname extension; override with
 *   `options.mimeType` when the URL has no usable extension.
 * - `avatar(buffer, { mimeType })` — set avatar from in-memory bytes.
 *   `options.mimeType` is required (enforced at the type level).
 *
 * `"clear"` is a reserved string-literal sentinel. If you have a file
 * literally named `clear` with no extension, pass `"./clear"` or load it as a
 * Buffer.
 */
export function avatar(
  input: string | URL,
  options?: { mimeType?: string }
): ContentBuilder;
export function avatar(
  input: Buffer,
  options: { mimeType: string }
): ContentBuilder;
export function avatar(
  input: AvatarInput,
  options?: { mimeType?: string }
): ContentBuilder {
  // Snapshot the action at builder construction so (a) a missing MIME type
  // fails fast and (b) the read is cached across repeated `build()` calls.
  const action = buildPhotoAction(input, options, "avatar");
  return {
    build: async () => avatarSchema.parse({ type: "avatar", action }),
  };
}
