import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Message as LocalIMessage } from "@photon-ai/imessage-kit";
import { type Content, fromVCard } from "@spectrum-ts/core";
import { asAttachment, asContact } from "@spectrum-ts/core/authoring";
import { isVCardAttachment } from "../shared/vcard";

export const DEFAULT_ATTACHMENT_NAME = "attachment";

export type LocalAttachment = LocalIMessage["attachments"][number];

export const readLocalAttachment = async (
  att: LocalAttachment
): Promise<Buffer> => {
  if (!att.localPath) {
    throw new Error(
      `iMessage attachment ${att.id} has no local file available on disk`
    );
  }
  return readFile(att.localPath);
};

const toAttachmentContent = (att: LocalAttachment): Content => {
  const { localPath } = att;
  return asAttachment({
    id: att.id,
    name: att.fileName ?? DEFAULT_ATTACHMENT_NAME,
    mimeType: att.mimeType,
    size: att.sizeBytes,
    read: () => readLocalAttachment(att),
    stream: localPath
      ? async () =>
          Readable.toWeb(
            createReadStream(localPath)
          ) as ReadableStream<Uint8Array>
      : undefined,
  });
};

const toVCardContent = async (att: LocalAttachment): Promise<Content> => {
  try {
    const buf = await readLocalAttachment(att);
    return asContact(fromVCard(buf.toString("utf8")));
  } catch {
    return toAttachmentContent(att);
  }
};

export const localAttachmentContent = async (
  att: LocalAttachment
): Promise<Content> =>
  isVCardAttachment(att.mimeType, att.fileName)
    ? await toVCardContent(att)
    : toAttachmentContent(att);
