import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import { asAttachment } from "../../content/attachment";
import { asContact } from "../../content/contact";
import type { Content } from "../../content/types";
import type { SendResult } from "../../platform/types";
import { UnsupportedError } from "../../utils/errors";
import { type ManagedStream, stream } from "../../utils/stream";
import { fromVCard, toVCard } from "../../utils/vcard";
import type { IMessageMessage } from "./types";

// v3 `IMessageSDK.send` resolves to `void` — the chat.db row id only
// surfaces later via the watcher's `onFromMeMessage`. A synthetic id
// satisfies spectrum's SendResult contract; iMessage local does not
// implement `editMessage`, so the id is never resolved back to a real row.
const synthSendResult = (): SendResult => ({
  id: crypto.randomUUID(),
  timestamp: new Date(),
});

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

type LocalAttachment = LocalIMessage["attachments"][number];

const readLocalAttachment = async (att: LocalAttachment): Promise<Buffer> => {
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

const toMessages = async (
  message: LocalIMessage
): Promise<IMessageMessage[]> => {
  const { chatId, chatKind } = message;
  if (!chatId || chatKind === "unknown") {
    return [];
  }

  // Drop rows spectrum's Content union cannot faithfully represent —
  // reactions, group events, and retracts would collapse to empty or
  // Apple-generated pseudo-text otherwise.
  if (
    message.reaction !== null ||
    message.kind !== "text" ||
    message.retractedAt !== null
  ) {
    return [];
  }

  const base: Omit<IMessageMessage, "id" | "content"> = {
    sender: { id: message.participant ?? "" },
    space: { id: chatId, type: chatKind === "group" ? "group" : "dm" },
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

    const startPromise = client
      .startWatching({
        onIncomingMessage: (message) => {
          lastPromise = lastPromise
            .then(() => toMessages(message))
            .then(async (ms) => {
              for (const m of ms) {
                await emit(m);
              }
            })
            .catch(end);
        },
        onError: end,
      })
      .catch(end);

    return async () => {
      await startPromise.catch(() => {});
      await client.stopWatching();
      // The incoming callback is sync (returns undefined), so `stopWatching`
      // does not wait for the `lastPromise` chain — drain it explicitly to
      // avoid `emit`/attachment reads running past teardown.
      await lastPromise.catch(() => {});
    };
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
): Promise<void> => {
  const safeName = basename(name) || DEFAULT_ATTACHMENT_NAME;
  const dir = await mkdtemp(join(tmpdir(), "spectrum-"));
  const tmp = join(dir, safeName);
  await writeFile(tmp, data);
  try {
    await client.send({ to: spaceId, attachments: [tmp] });
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
      await client.send({ to: spaceId, text: content.text });
      return synthSendResult();
    case "attachment":
      await sendTempFile(client, spaceId, content.name, await content.read());
      return synthSendResult();
    case "contact": {
      const vcf = await toVCard(content);
      await sendTempFile(
        client,
        spaceId,
        vcardFileName(content),
        Buffer.from(vcf, "utf8")
      );
      return synthSendResult();
    }
    default:
      throw UnsupportedError.content(content.type, "iMessage (local mode)");
  }
};

// Local mode has no by-id SDK lookup and does not surface reactions, so it
// has no cache to consult. `space.getMessage(id)` always resolves to
// `undefined` on local — callers with only an id cannot materialize a Message
// here.
export const getMessage = async (
  _client: IMessageSDK,
  _id: string
): Promise<IMessageMessage | undefined> => undefined;
