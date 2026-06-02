const PART_PREFIX = /^p:(\d+)\//;

export type AttachmentGuid = string;
export type ChatGuid = string;
export type MessageGuid = string;

export const dmChatGuid = (address: string): ChatGuid => `any;-;${address}`;

const DM_GUID_SEPARATOR = ";-;";

/**
 * Inverse of `dmChatGuid`: recover the participant address from a DM chat guid.
 * Handles both the outbound form (`any;-;+1…`) and the inbound form
 * (`iMessage;-;+1…`). Falls back to the whole guid when no separator is present.
 * Group guids use `;+;` and are never passed here.
 */
export const dmAddress = (chatGuid: ChatGuid): string => {
  const idx = chatGuid.indexOf(DM_GUID_SEPARATOR);
  return idx === -1 ? chatGuid : chatGuid.slice(idx + DM_GUID_SEPARATOR.length);
};

export const toChatGuid = (value: string): ChatGuid => value;

export const toMessageGuid = (value: string): MessageGuid => value;

export const formatChildId = (partIndex: number, parentGuid: string): string =>
  `p:${partIndex}/${parentGuid}`;

export const parseTapbackTarget = (
  target: string
): { guid: string; partIndex: number } => {
  const match = target.match(PART_PREFIX);
  const guid = target.replace(PART_PREFIX, "");
  const partIndex = match ? Number(match[1]) : 0;
  return { guid, partIndex };
};

export const parseChildId = (
  id: string
): { parentGuid: string; partIndex: number } | null => {
  const match = id.match(PART_PREFIX);
  if (!match) {
    return null;
  }
  return {
    parentGuid: id.replace(PART_PREFIX, ""),
    partIndex: Number(match[1]),
  };
};
