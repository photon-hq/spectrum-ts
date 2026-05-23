import type { Content, ContentInput } from "../content/types";
import type { Space } from "./space";
import type { AgentSender, User } from "./user";

export interface Message<
  TPlatform extends string = string,
  TSender extends User = User,
  TSpace extends Space = Space,
> {
  content: Content;
  direction: "inbound" | "outbound";
  edit(newContent: ContentInput): Promise<void>;
  readonly id: string;
  platform: TPlatform;
  react(reaction: string): Promise<void>;
  reply(
    content: ContentInput
  ): Promise<Message<TPlatform, AgentSender, TSpace> | undefined>;
  reply(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<Message<TPlatform, AgentSender, TSpace>[]>;
  sender: TSender | undefined;
  space: TSpace;
  timestamp: Date;
}
