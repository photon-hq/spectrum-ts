// GENERATED FILE — do not edit by hand.
// Source: providers/telegram/bot-api-spec/schema/telegram.json
// Regenerate with: bun run gen:telegram


export type InputFile = string | Blob;

/** Incoming update. At most one of the optional parameters can be present in any given update. */
export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  edited_channel_post?: Message;
  message_reaction?: MessageReactionUpdated;
  /** New aggregate poll state. Bots receive only updates about stopped polls and polls they sent. */
  poll?: Poll;
  /** User changed their vote in a non-anonymous poll. Anonymous polls do NOT emit poll_answer. */
  poll_answer?: PollAnswer;
}

/** Telegram user or bot. */
export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/** Chat (private, group, supergroup, or channel). */
export interface Chat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

/** A message. */
export interface Message {
  message_id: number;
  /** Unix time */
  date: number;
  chat: Chat;
  from?: User;
  /** Sender of the message, sent on behalf of a chat (channel posts, anonymous group admins). */
  sender_chat?: Chat;
  text?: string;
  caption?: string;
  entities?: Array<MessageEntity>;
  link_preview_options?: LinkPreviewOptions;
  photo?: Array<PhotoSize>;
  document?: Document;
  audio?: Audio;
  video?: Video;
  voice?: Voice;
  contact?: Contact;
  poll?: Poll;
  /** Set on each member of an album. All messages sent together share the same id; absent on standalone messages. */
  media_group_id?: string;
}

/** A special entity in a text message (URL, mention, hashtag, etc.). */
export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  /** For text_link only: the URL to open */
  url?: string;
}

/** Describes link-preview generation options for a message. */
export interface LinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
}

/** One size of a photo. */
export interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** General file (as opposed to photo/voice/video/audio). */
export interface Document {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Audio file to be treated as music. */
export interface Audio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Video file. */
export interface Video {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Voice note. */
export interface Voice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

/** Phone contact. */
export interface Contact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
  vcard?: string;
}

/** Reaction type. Flat union shape: discriminate at runtime via `type`. */
export interface ReactionType {
  type: "emoji" | "custom_emoji" | "paid";
  /** Set when type === "emoji". */
  emoji?: string;
  /** Set when type === "custom_emoji". */
  custom_emoji_id?: string;
}

/** A reaction on a message changed by a user. */
export interface MessageReactionUpdated {
  chat: Chat;
  message_id: number;
  /** Unix time of the change */
  date: number;
  user?: User;
  actor_chat?: Chat;
  old_reaction: Array<ReactionType>;
  new_reaction: Array<ReactionType>;
}

/** Option in a Telegram poll. */
export interface PollOption {
  text: string;
  voter_count: number;
}

/** Outbound option used by `sendPoll`. */
export interface InputPollOption {
  text: string;
}

/** A native Telegram poll (regular or quiz). Spectrum exposes only regular polls; quiz/explanation/period fields are passed through but not modelled in the universal Content. */
export interface Poll {
  id: string;
  question: string;
  options: Array<PollOption>;
  total_voter_count: number;
  is_closed: boolean;
  is_anonymous: boolean;
  type: "regular" | "quiz";
  allows_multiple_answers: boolean;
  /** Bot API 9.6+: 0-based identifiers of the correct answer options. Quiz polls only; available when the poll is closed or sent (not forwarded) by the bot. Replaces the pre-9.6 singular `correct_option_id`. */
  correct_option_ids?: Array<number>;
  /** Bot API 9.6+: True if the poll allows changing the chosen answer after voting. */
  allows_revoting?: boolean;
}

/** Answer of a user in a non-anonymous poll. Spectrum keys vote-state caches by `poll_id`; chat/message_id are not provided by Telegram in this update so the poll cache must be populated when the poll is created or first observed. */
export interface PollAnswer {
  poll_id: string;
  /** Set when the vote came from an anonymous channel admin acting on behalf of the channel. */
  voter_chat?: Chat;
  /** Set when the vote came from a regular user. Either `user` or `voter_chat` is present. */
  user?: User;
  /** Zero-based indices into the original poll options. Empty array means the user retracted all of their votes. */
  option_ids: Array<number>;
}

/** Reply parameters for outgoing messages. */
export interface ReplyParameters {
  message_id: number;
}

/** Error response parameters. */
export interface ResponseParameters {
  retry_after?: number;
  migrate_to_chat_id?: number;
}

/** Downloadable file descriptor. */
export interface File {
  file_id: string;
  file_size?: number;
  file_path?: string;
}
