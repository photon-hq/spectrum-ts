import type { AvatarData } from "../content/avatar";
import type { MemberInput } from "../content/membership";
import type { Reaction, ReactionBuilder } from "../content/reaction";
import type { ContentInput } from "../content/types";
import type { Message } from "./message";
import type { AgentSender, User } from "./user";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  /**
   * Add members to the current chat. Sugar for `send(addMember(users))`.
   * Accepts a single `User` or id string, or an array of either — batches
   * land in one provider call. Fire-and-forget.
   *
   * Universal API; per-platform constraints (e.g. iMessage: remote + group
   * only — a DM cannot be converted, create a group via `space.create`)
   * surface as `UnsupportedError` from the provider's send action.
   */
  add(users: MemberInput): Promise<void>;
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
   * Download the current chat avatar (group icon). Resolves `undefined` when
   * the chat has none. The result round-trips into the setter:
   * `space.avatar(res.data, { mimeType: res.mimeType })`.
   *
   * Universal API; per-platform constraints (e.g. iMessage: remote + group
   * only — a DM throws) surface as `UnsupportedError`, as do platforms with
   * no implementation.
   */
  getAvatar(): Promise<AvatarData | undefined>;
  /**
   * List the chat's current participants, excluding the agent's own account
   * where the platform can identify it. Each entry is a `User` tagged with
   * `__platform`; `id` is the user's canonical platform handle (the same
   * format `space.create` accepts), so results feed straight back into
   * `add()` / `remove()` / `space.create()`. Platform extras (e.g.
   * iMessage's `address`/`country`/`service`) ride along untyped — use the
   * platform instance's `getMembers(space)` for typed extras.
   *
   * Universal API; per-platform constraints (e.g. iMessage: remote + group
   * only — a DM throws) surface as `UnsupportedError`, as do platforms with
   * no implementation.
   */
  getMembers(): Promise<User[]>;
  /**
   * Look up a message in this space by its id. Returns `undefined` if the
   * platform has no way to resolve the id (e.g. cache miss with no by-id
   * SDK fallback). Used to materialize a `Message` for APIs that require one,
   * such as `reaction()`.
   */
  getMessage(id: string): Promise<Message | undefined>;
  readonly id: string;
  /**
   * Leave the current chat with the agent's own account. Sugar for
   * `send(leaveSpace())`. Fire-and-forget.
   *
   * Universal API; per-platform constraints (e.g. iMessage: remote + group
   * only) surface as `UnsupportedError` from the provider's send action.
   */
  leave(): Promise<void>;
  /**
   * Mark the conversation as read up to `message`, surfacing a read receipt
   * to the sender where the platform supports one. Sugar for
   * `send(read(message))`. Fire-and-forget; only inbound messages can be
   * marked read.
   *
   * Granularity is per-platform: WhatsApp Business issues a receipt for
   * `message` and everything before it; iMessage (remote) marks the whole
   * chat read. Platforms with no read-receipt concept for bot conversations
   * (Telegram, Slack) silently no-op, so the signal is best-effort
   * everywhere — same contract as `startTyping()`.
   */
  read(message: Message): Promise<void>;
  /**
   * Remove members from the current chat. Sugar for
   * `send(removeMember(users))`. Accepts the same input shapes as `add`.
   * Fire-and-forget.
   *
   * Universal API; per-platform constraints (e.g. iMessage: remote + group
   * only) surface as `UnsupportedError` from the provider's send action.
   */
  remove(users: MemberInput): Promise<void>;
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
