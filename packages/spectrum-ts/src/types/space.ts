import type { ContentInput } from "../content/types";
import type { OutboundMessage } from "./message";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  edit(message: OutboundMessage, newContent: ContentInput): Promise<void>;
  readonly id: string;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  send(content: ContentInput): Promise<OutboundMessage>;
  send(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage[]>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
}
