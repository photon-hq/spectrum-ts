import type { Reaction } from "../content/reaction";
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
  /**
   * React to this message. Resolves to the reaction `Message` (content
   * narrowed to `Reaction`) — keep it as the handle for a future unsend.
   * Resolves `undefined` when the platform does not support reactions
   * (warned and skipped).
   *
   * The return type is an inline intersection rather than a `TContent`
   * generic on `Message`: a content type parameter would need `Content` as
   * its default, and `Content`'s schemas (`reaction`, `reply`, `edit`,
   * `group`) reference `Message` — TS rejects the resulting circular
   * default (TS2716).
   */
  react(
    reaction: string
  ): Promise<
    | (Message<TPlatform, AgentSender, TSpace> & { content: Reaction })
    | undefined
  >;
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
