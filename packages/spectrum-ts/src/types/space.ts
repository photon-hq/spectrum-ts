import type { ContentInput } from "../content/types";
import type { Message } from "./message";
import type { AgentSender } from "./user";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  edit(message: Message, newContent: ContentInput): Promise<void>;
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
  send(
    content: ContentInput
  ): Promise<Message<string, AgentSender> | undefined>;
  send(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<Message<string, AgentSender>[]>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
}
