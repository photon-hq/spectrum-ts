// GENERATED FILE — do not edit by hand.
// Source: providers/telegram/bot-api-spec/schema/telegram.json
// Regenerate with: bun run gen:telegram


import type {
  Audio,
  Chat,
  Contact,
  Document,
  File,
  InputPollOption,
  LinkPreviewOptions,
  Message,
  MessageEntity,
  MessageReactionUpdated,
  PhotoSize,
  Poll,
  PollAnswer,
  PollOption,
  ReactionType,
  ReplyParameters,
  ResponseParameters,
  Update,
  User,
  Video,
  Voice,
  InputFile,
} from "./types";

/** Returns basic info about the bot. */
export type GetMeParams = Record<string, never>;

/** Receives incoming updates using long polling. */
export interface GetUpdatesParams {
  offset?: number;
  /** Long-polling timeout in seconds */
  timeout?: number;
  allowed_updates?: Array<string>;
}

/** Sends a text message. */
export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  link_preview_options?: LinkPreviewOptions;
  reply_parameters?: ReplyParameters;
}

/** Sends a photo. */
export interface SendPhotoParams {
  chat_id: number | string;
  photo: InputFile;
  reply_parameters?: ReplyParameters;
}

/** Sends a general file. */
export interface SendDocumentParams {
  chat_id: number | string;
  document: InputFile;
  reply_parameters?: ReplyParameters;
}

/** Sends an audio file shown as music. */
export interface SendAudioParams {
  chat_id: number | string;
  audio: InputFile;
  reply_parameters?: ReplyParameters;
}

/** Sends a video. */
export interface SendVideoParams {
  chat_id: number | string;
  video: InputFile;
  reply_parameters?: ReplyParameters;
}

/** Sends an audio file to be displayed as a voice note. */
export interface SendVoiceParams {
  chat_id: number | string;
  voice: InputFile;
  duration?: number;
  reply_parameters?: ReplyParameters;
}

/** Sends a phone contact. */
export interface SendContactParams {
  chat_id: number | string;
  phone_number: string;
  first_name: string;
  last_name?: string;
  vcard?: string;
  reply_parameters?: ReplyParameters;
}

/** Sends a native Telegram poll. Spectrum sends regular (non-quiz) polls with `is_anonymous: false` so per-user vote events surface as poll_option content. Private 1:1 chats, groups, supergroups, and channels are all supported; the only chat type Telegram rejects is channel direct-message chats (the per-user threads on top of broadcast channels), which return BAD_REQUEST. */
export interface SendPollParams {
  chat_id: number | string;
  question: string;
  options: Array<InputPollOption>;
  /** Defaults to true on the Telegram side. Spectrum forces this to `false` on outbound sends so vote events are attributed. */
  is_anonymous?: boolean;
  /** Spectrum only sends regular polls. Quiz mode is intentionally out of scope: it requires `correct_option_ids`, and Spectrum's universal `poll` content has no notion of quiz correct-answer metadata. Callers needing quizzes should use the raw client directly. */
  type?: "regular";
  allows_multiple_answers?: boolean;
  /** Bot API 9.6+: pass true to allow voters to change their selection after voting. */
  allows_revoting?: boolean;
  /** Bot API 9.6+: pass true to randomize the order of options when displaying the poll. */
  shuffle_options?: boolean;
  /** Bot API 9.6+: pass true to let users add options after the poll has been created. */
  allow_adding_options?: boolean;
  /** Bot API 9.6+: pass true to hide aggregate results until the poll is closed. */
  hide_results_until_closes?: boolean;
  reply_parameters?: ReplyParameters;
}

/** Stops a poll the bot started. Returns the final Poll state. Not exposed through Spectrum's universal API; available via raw client for callers who need it. */
export interface StopPollParams {
  chat_id: number | string;
  message_id: number;
}

/** Edits a text message. */
export interface EditMessageTextParams {
  chat_id: number | string;
  message_id: number;
  text: string;
  link_preview_options?: LinkPreviewOptions;
}

/** Sets reactions on a message. */
export interface SetMessageReactionParams {
  chat_id: number | string;
  message_id: number;
  reaction?: Array<ReactionType>;
}

/** Broadcasts a chat action. */
export interface SendChatActionParams {
  chat_id: number | string;
  action: "typing";
}

/** Gets a chat by ID. */
export interface GetChatParams {
  chat_id: number | string;
}

/** Gets basic info about a file. Compose with baseUrl + /file/bot<TOKEN>/<file_path> to download. */
export interface GetFileParams {
  file_id: string;
}

/** Bot API method map. Used by the runtime client for type-safe invoke(). */
export interface Methods {
  getMe: {
    params: GetMeParams;
    result: User;
  };
  getUpdates: {
    params: GetUpdatesParams;
    result: Array<Update>;
  };
  sendMessage: {
    params: SendMessageParams;
    result: Message;
  };
  sendPhoto: {
    params: SendPhotoParams;
    result: Message;
  };
  sendDocument: {
    params: SendDocumentParams;
    result: Message;
  };
  sendAudio: {
    params: SendAudioParams;
    result: Message;
  };
  sendVideo: {
    params: SendVideoParams;
    result: Message;
  };
  sendVoice: {
    params: SendVoiceParams;
    result: Message;
  };
  sendContact: {
    params: SendContactParams;
    result: Message;
  };
  sendPoll: {
    params: SendPollParams;
    result: Message;
  };
  stopPoll: {
    params: StopPollParams;
    result: Poll;
  };
  editMessageText: {
    params: EditMessageTextParams;
    result: Message | boolean;
  };
  setMessageReaction: {
    params: SetMessageReactionParams;
    result: boolean;
  };
  sendChatAction: {
    params: SendChatActionParams;
    result: boolean;
  };
  getChat: {
    params: GetChatParams;
    result: Chat;
  };
  getFile: {
    params: GetFileParams;
    result: File;
  };
}

export type MethodName = keyof Methods;

export const BASE_URL = "https://api.telegram.org";
export const API_VERSION = "9.6";
