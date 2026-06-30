export const ATTACHMENT_PLACEHOLDER = "\uFFFC";

export type OrderedPart<TAttachment extends object> =
  | { readonly text: string; readonly type: "text" }
  | { readonly attachment: TAttachment; readonly type: "attachment" };

const addTextPart = <TAttachment extends object>(
  parts: OrderedPart<TAttachment>[],
  text: string | undefined
): void => {
  const trimmed = text?.trim();
  if (trimmed) {
    parts.push({ type: "text", text: trimmed });
  }
};

export const hasUsableTextPart = (text: string | null | undefined): boolean =>
  text?.split(ATTACHMENT_PLACEHOLDER).some((segment) => segment.trim()) ??
  false;

const addAttachmentParts = <TAttachment extends object>(
  parts: OrderedPart<TAttachment>[],
  attachments: readonly TAttachment[]
): void => {
  for (const attachment of attachments) {
    if (attachment) {
      parts.push({ type: "attachment", attachment });
    }
  }
};

export const toOrderedParts = <TAttachment extends object>(
  text: string | null | undefined,
  attachments: readonly TAttachment[]
): readonly OrderedPart<TAttachment>[] => {
  const parts: OrderedPart<TAttachment>[] = [];

  if (!text) {
    addAttachmentParts(parts, attachments);
    return parts;
  }

  if (!text.includes(ATTACHMENT_PLACEHOLDER)) {
    addAttachmentParts(parts, attachments);
    addTextPart(parts, text);
    return parts;
  }

  const textSegments = text.split(ATTACHMENT_PLACEHOLDER);
  for (let i = 0; i < attachments.length; i++) {
    addTextPart(parts, textSegments[i]);

    const attachment = attachments[i];
    if (attachment) {
      parts.push({ type: "attachment", attachment });
    }
  }

  addTextPart(parts, textSegments.slice(attachments.length).join(""));
  return parts;
};
