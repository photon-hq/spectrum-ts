// GENERATED FILE — do not edit by hand.
// Source: bot-api-spec/schema/telegram.json
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
