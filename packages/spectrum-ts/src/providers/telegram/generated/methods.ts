// GENERATED FILE — do not edit by hand.
// Source: bot-api-spec/schema/telegram.json
// Regenerate with: bun run gen:telegram


import type {
  Audio,
  Chat,
  Contact,
  Document,
  File,
  LinkPreviewOptions,
  Message,
  MessageEntity,
  PhotoSize,
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
export const API_VERSION = "8.3";
