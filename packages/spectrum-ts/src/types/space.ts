import type { ContentInput } from "../content/types";
import type { Message, OutboundMessage } from "./message";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  edit(message: OutboundMessage, newContent: ContentInput): Promise<void>;
  /**
   * Look up a message in this space by its id. Returns `undefined` if the
   * platform has no way to resolve the id (e.g. cache miss with no by-id
   * SDK fallback). Used to materialize a `Message` for APIs that require one,
   * such as `reaction()`.
   */
  getMessage(id: string): Promise<Message | undefined>;
  readonly id: string;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  send(content: ContentInput): Promise<OutboundMessage | undefined>;
  send(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage[]>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
}
