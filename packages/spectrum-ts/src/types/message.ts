import type { Content, ContentInput } from "../content/types";
import type { Space } from "./space";
import type { User } from "./user";

export interface Message<
  TPlatform extends string = string,
  TSender extends User = User,
  TSpace extends Space = Space,
> {
  content: Content;
  copy(toSpaceId: string): Promise<void>;
  delete(): Promise<void>;
  edit(...content: [ContentInput, ...ContentInput[]]): Promise<void>;
  forward(toSpaceId: string): Promise<void>;
  readonly id: string;
  pin(): Promise<void>;
  platform: TPlatform;
  react(reaction: string): Promise<void>;
  reply(...content: [ContentInput, ...ContentInput[]]): Promise<void>;
  sender: TSender;
  space: TSpace;
  timestamp: Date;
  unpin(): Promise<void>;
}
