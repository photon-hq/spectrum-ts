import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import {
  type IMessageSDK,
  type Message as LocalIMessage,
  readAttachmentBytes,
} from "@photon-ai/imessage-kit";
import { asAttachment } from "../../content/attachment";
import { asContact } from "../../content/contact";
import type { Content } from "../../content/types";
import type { SendResult } from "../../platform/types";
import { type ManagedStream, stream } from "../../utils/stream";
import { fromVCard, toVCard } from "../../utils/vcard";
import type { IMessageMessage } from "./types";

type LocalSendResult = Awaited<ReturnType<IMessageSDK["send"]>>;

const toSendResult = (result: LocalSendResult): SendResult => {
  if (!result.message?.id) {
    throw new Error(
      "iMessage local send did not return a message id — track upstream in @photon-ai/imessage-kit"
    );
  }
  return { id: result.message.id, timestamp: result.sentAt };
};

const DEFAULT_ATTACHMENT_NAME = "attachment";

const VCARD_MIME_TYPES: ReadonlySet<string> = new Set([
  "text/vcard",
  "text/x-vcard",
  "text/directory",
  "application/vcard",
  "application/x-vcard",
]);

const normalizeMimeType = (mimeType: string): string =>
  (mimeType.split(";")[0] ?? "").trim().toLowerCase();

const isVCardAttachment = (
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): boolean => {
  if (mimeType && VCARD_MIME_TYPES.has(normalizeMimeType(mimeType))) {
    return true;
  }
  return Boolean(fileName?.toLowerCase().endsWith(".vcf"));
};

const toSpace = (message: LocalIMessage): IMessageMessage["space"] => ({
  id: message.chatId,
  type: message.chatKind === "group" ? "group" : "dm",
});

type LocalAttachment = LocalIMessage["attachments"][number];

const toAttachmentContent = (att: LocalAttachment): Content => {
  const { localPath } = att;
  return asAttachment({
    name: att.fileName ?? DEFAULT_ATTACHMENT_NAME,
    mimeType: att.mimeType,
    size: att.sizeBytes,
    read: () => readAttachmentBytes(att),
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
    const buf = await readAttachmentBytes(att);
    return asContact(fromVCard(buf.toString("utf8")));
  } catch {
    return toAttachmentContent(att);
  }
};

const toMessages = async (
  message: LocalIMessage
): Promise<IMessageMessage[]> => {
  const base = {
    sender: { id: message.participant ?? "" },
    space: toSpace(message),
    timestamp: message.createdAt,
  };

  if (message.attachments.length > 0) {
    return Promise.all(
      message.attachments.map(async (att) => ({
        ...base,
        id: `${message.id}:${att.id}`,
        content: isVCardAttachment(att.mimeType, att.fileName)
          ? await toVCardContent(att)
          : toAttachmentContent(att),
      }))
    );
  }

  return [
    {
      ...base,
      id: message.id,
      content: { type: "text", text: message.text ?? "" },
    },
  ];
};

export const messages = (client: IMessageSDK): ManagedStream<IMessageMessage> =>
  stream((emit, end) => {
    let lastPromise: Promise<void> = Promise.resolve();
    client.startWatching({
      onMessage: (message) => {
        if (message.isFromMe) {
          return;
        }
        lastPromise = lastPromise
          .then(() => toMessages(message))
          .then((ms) => {
            for (const m of ms) {
              emit(m);
            }
          })
          .catch((error) => end(error));
      },
    });
    return () => client.stopWatching();
  });

const vcardFileName = (
  content: Extract<Content, { type: "contact" }>
): string => {
  const base = content.name?.formatted ?? content.user?.id ?? "contact";
  return `${base.replace(/[^a-zA-Z0-9_\-.]/g, "_")}.vcf`;
};

const sendTempFile = async (
  client: IMessageSDK,
  spaceId: string,
  name: string,
  data: Buffer
): Promise<LocalSendResult> => {
  const safeName = basename(name) || DEFAULT_ATTACHMENT_NAME;
  const dir = await mkdtemp(join(tmpdir(), "spectrum-"));
  const tmp = join(dir, safeName);
  await writeFile(tmp, data);
  try {
    return await client.send(spaceId, { attachments: [tmp] });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

export const send = async (
  client: IMessageSDK,
  spaceId: string,
  content: Content
): Promise<SendResult> => {
  switch (content.type) {
    case "text":
      return toSendResult(await client.send(spaceId, content.text));
    case "attachment":
      return toSendResult(
        await sendTempFile(client, spaceId, content.name, await content.read())
      );
    case "contact": {
      const vcf = await toVCard(content);
      return toSendResult(
        await sendTempFile(
          client,
          spaceId,
          vcardFileName(content),
          Buffer.from(vcf, "utf8")
        )
      );
    }
    default:
      throw new Error(
        `Unsupported iMessage local content type: ${content.type}`
      );
  }
};
