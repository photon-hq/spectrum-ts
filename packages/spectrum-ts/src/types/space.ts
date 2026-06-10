import type { Reaction, ReactionBuilder } from "../content/reaction";
import type { ContentInput } from "../content/types";
import type { Message } from "./message";
import type { AgentSender } from "./user";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  /**
   * Set or clear the current chat's avatar (group icon). Sugar for
   * `send(avatar(input, options?))`.
   *
   * - `space.avatar("clear")` — remove the current avatar.
   * - `space.avatar("./icon.png")` — set from a filesystem path; MIME type
   *   is inferred from the extension.
   * - `space.avatar(new URL("https://…/icon.png"))` — fetch the avatar
   *   lazily over the network. Bytes stay in memory (safe in read-only
   *   environments); MIME type is inferred from the URL pathname extension.
   * - `space.avatar(buffer, { mimeType })` — set from in-memory bytes;
   *   `mimeType` is required (enforced at the type level).
   *
   * Universal API; per-platform constraints (e.g. iMessage: remote + group
   * only) surface as `UnsupportedError` from the provider's send action.
   */
  avatar(input: string | URL, options?: { mimeType?: string }): Promise<void>;
  avatar(input: Buffer, options: { mimeType: string }): Promise<void>;
  /**
   * Rewrite a previously-sent outbound message. Sugar for
   * `send(edit(newContent, message))`. Accepts `Message | undefined` so
   * `send` results chain without narrowing; an undefined target throws.
   */
  edit(message: Message | undefined, newContent: ContentInput): Promise<void>;
  /**
   * Look up a message in this space by its id. Returns `undefined` if the
   * platform has no way to resolve the id (e.g. cache miss with no by-id
   * SDK fallback). Used to materialize a `Message` for APIs that require one,
   * such as `reaction()`.
   */
  getMessage(id: string): Promise<Message | undefined>;
  readonly id: string;
  /**
   * Rename the current chat. Sugar for `send(rename(displayName))`.
   *
   * Universal API; per-platform constraints (e.g. iMessage: remote + group
   * only) surface as `UnsupportedError` from the provider's send action.
   */
  rename(displayName: string): Promise<void>;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * A reaction send resolves to the reaction Message (`content` narrowed to
   * `Reaction`) — the handle to `unsend()` later. Listed before the general
   * overload so `send(reaction(...))` picks it; every other `ContentBuilder`
   * fails the `ReactionBuilder` shape and falls through.
   */
  send(
    content: ReactionBuilder
  ): Promise<
    (Message<string, AgentSender> & { content: Reaction }) | undefined
  >;
  send(
    content: ContentInput
  ): Promise<Message<string, AgentSender> | undefined>;
  send(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<Message<string, AgentSender>[]>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
  /**
   * Retract a previously-sent outbound message. Sugar for
   * `send(unsend(message))`. Accepts `Message | undefined` so `send`
   * results chain without narrowing; an undefined target throws.
   */
  unsend(message: Message | undefined): Promise<void>;
}
