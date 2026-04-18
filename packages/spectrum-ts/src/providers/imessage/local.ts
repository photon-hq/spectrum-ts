import { createReadStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type IMessageSDK,
  type Message as LocalIMessage,
  readAttachmentBytes,
} from "@photon-ai/imessage-kit";
import { asAttachment } from "../../content/attachment";
import type { Content } from "../../content/types";
import { type ManagedStream, stream } from "../../utils/stream";
import type { IMessageMessage } from "./types";

const DEFAULT_ATTACHMENT_NAME = "attachment";

const toSpace = (message: LocalIMessage): IMessageMessage["space"] => ({
  id: message.chatId,
  type: message.chatKind === "group" ? "group" : "dm",
});

const toMessages = (message: LocalIMessage): IMessageMessage[] => {
  const base = {
    sender: { id: message.participant ?? "" },
    space: toSpace(message),
    timestamp: message.createdAt,
  };

  if (message.attachments.length > 0) {
    return message.attachments.map((att) => {
      const { localPath } = att;
      return {
        ...base,
        id: `${message.id}:${att.id}`,
        content: asAttachment({
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
        }),
      };
    });
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
    client.startWatching({
      onMessage: (message) => {
        try {
          for (const m of toMessages(message)) {
            emit(m);
          }
        } catch (error) {
          end(error);
        }
      },
    });
    return () => client.stopWatching();
  });

export const send = async (
  client: IMessageSDK,
  spaceId: string,
  content: Content
) => {
  switch (content.type) {
    case "text":
      await client.send(spaceId, content.text);
      break;
    case "attachment": {
      const tmp = join(tmpdir(), `spectrum-${Date.now()}-${content.name}`);
      await writeFile(tmp, await content.read());
      try {
        await client.send(spaceId, { attachments: [tmp] });
      } finally {
        await unlink(tmp).catch(() => {});
      }
      break;
    }
    default:
      break;
  }
};
