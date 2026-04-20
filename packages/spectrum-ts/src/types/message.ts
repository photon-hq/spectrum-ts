import type { Content, ContentInput } from "../content/types";
import type { Space } from "./space";
import type { User } from "./user";

interface BaseMessage<
  TPlatform extends string = string,
  TSender extends User = User,
  TSpace extends Space = Space,
> {
  content: Content;
  readonly id: string;
  platform: TPlatform;
  react(reaction: string): Promise<void>;
  reply(
    content: ContentInput
  ): Promise<OutboundMessage<TPlatform, TSender, TSpace>>;
  reply(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage<TPlatform, TSender, TSpace>[]>;
  space: TSpace;
  timestamp: Date;
}

export interface InboundMessage<
  TPlatform extends string = string,
  TSender extends User = User,
  TSpace extends Space = Space,
> extends BaseMessage<TPlatform, TSender, TSpace> {
  direction: "inbound";
  sender: TSender;
}

export interface OutboundMessage<
  TPlatform extends string = string,
  TSender extends User = User,
  TSpace extends Space = Space,
> extends BaseMessage<TPlatform, TSender, TSpace> {
  direction: "outbound";
  edit(newContent: ContentInput): Promise<void>;
  sender: TSender | undefined;
}

export type Message<
  TPlatform extends string = string,
  TSender extends User = User,
  TSpace extends Space = Space,
> =
  | InboundMessage<TPlatform, TSender, TSpace>
  | OutboundMessage<TPlatform, TSender, TSpace>;
