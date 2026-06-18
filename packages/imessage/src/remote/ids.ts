const PART_PREFIX = /^p:(\d+)\//;

export type AttachmentGuid = string;
export type ChatGuid = string;
export type MessageGuid = string;

export const dmChatGuid = (address: string): ChatGuid => `any;-;${address}`;

// Chat guids encode their kind in the separator: groups use `;+;`
// (e.g. `iMessage;+;chat123…`), DMs use `;-;` (e.g. `any;-;+1555…`).
export const chatTypeFromGuid = (guid: ChatGuid): "dm" | "group" =>
  guid.includes(";+;") ? "group" : "dm";

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
