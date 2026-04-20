import type { ContentInput } from "../content/types";
import type { Message } from "./message";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  edit(message: Message, newContent: ContentInput): Promise<void>;
  readonly id: string;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  send(...content: [ContentInput, ...ContentInput[]]): Promise<void>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
}
