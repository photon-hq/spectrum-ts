import { UnsupportedError } from "@spectrum-ts/core";

export const IMESSAGE_PLATFORM = "iMessage";
export const LOCAL_IMESSAGE_PLATFORM = "iMessage (local mode)";

export const unsupportedRemoteContent = (
  type: string,
  detail?: string
): UnsupportedError =>
  UnsupportedError.content(type, IMESSAGE_PLATFORM, detail);

export const unsupportedLocalContent = (
  type: string,
  detail?: string
): UnsupportedError =>
  UnsupportedError.content(type, LOCAL_IMESSAGE_PLATFORM, detail);
