import type { ContentInput } from "../content/types";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  copyMessage(messageId: string, toSpaceId: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  editMessage(
    messageId: string,
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<void>;
  forwardMessage(messageId: string, toSpaceId: string): Promise<void>;
  readonly id: string;
  pinMessage(messageId: string): Promise<void>;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  send(...content: [ContentInput, ...ContentInput[]]): Promise<void>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
  unpinMessage(messageId: string): Promise<void>;
}
