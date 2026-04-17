import type { ContentInput } from "./content";

export interface Space<_Def = unknown> {
  readonly __platform: string;
  readonly id: string;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  send(...content: [ContentInput, ...ContentInput[]]): Promise<void>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
}
