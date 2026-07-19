import { UnsupportedError } from "@spectrum-ts/core";
import { IMESSAGE_PLATFORM } from "../platform";

const LOCAL_IMESSAGE_PLATFORM = "local_imessage";

export const unsupportedRemoteContent = (
  type: string,
  detail?: string
): UnsupportedError =>
  UnsupportedError.content(type, IMESSAGE_PLATFORM, detail);

export const unsupportedLocalContent = (
  type: string,
  detail?: string
): UnsupportedError =>
  UnsupportedError.content(
    type,
    LOCAL_IMESSAGE_PLATFORM,
    detail ? `local mode: ${detail}` : "local mode"
  );
