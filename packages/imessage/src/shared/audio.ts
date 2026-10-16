const AUDIO_MIME_PATTERN = /^audio\//i;
const CAF_MIME_TYPE = "audio/x-caf";
const CAF_UTI = "com.apple.coreaudio-format";
const GENERIC_BINARY_MIME_TYPE = "application/octet-stream";

interface AppleAttachmentAudioMetadata {
  readonly fileName?: string | null;
  readonly mimeType: string;
  readonly uti?: string | null;
}

const isCafAttachment = (attachment: AppleAttachmentAudioMetadata): boolean =>
  attachment.uti?.toLowerCase() === CAF_UTI ||
  attachment.fileName?.toLowerCase().endsWith(".caf") === true;

export const normalizeAppleAttachmentMimeType = (
  attachment: AppleAttachmentAudioMetadata
): string =>
  attachment.mimeType.toLowerCase() === GENERIC_BINARY_MIME_TYPE &&
  isCafAttachment(attachment)
    ? CAF_MIME_TYPE
    : attachment.mimeType;

export const appleAudioMimeType = (
  attachment: AppleAttachmentAudioMetadata
): string | undefined => {
  const mimeType = normalizeAppleAttachmentMimeType(attachment);
  return AUDIO_MIME_PATTERN.test(mimeType) ? mimeType : undefined;
};

/**
 * Resolve the voice MIME for an attachment of an audio message.
 *
 * Native voice recordings are CAF by format, so when Apple's record flags the
 * message as an audio message but the provider did not preserve the CAF UTI
 * or filename extension, the `isAudioMessage` flag is itself reliable format
 * evidence. The fallback only applies to attachments that declare no real
 * type — a declared MIME (even a contradictory one) wins over the flag.
 */
export const appleVoiceMimeType = (
  attachment: AppleAttachmentAudioMetadata,
  isAudioMessage: boolean
): string | undefined => {
  const detected = appleAudioMimeType(attachment);
  if (detected) {
    return detected;
  }
  return isAudioMessage &&
    attachment.mimeType.toLowerCase() === GENERIC_BINARY_MIME_TYPE
    ? CAF_MIME_TYPE
    : undefined;
};
