import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const toMessages = async (
  message: LocalIMessage
): Promise<IMessageMessage[]> => {
  const base = {
    sender: { id: message.participant ?? "" },
    space: toSpace(message),
    timestamp: message.createdAt,
  };

  if (message.attachments.length > 0) {
    return await Promise.all(
      message.attachments.map(async (att) => ({
        ...base,
        id: `${message.id}:${att.id}`,
        content: asAttachment({
          data: await readAttachmentBytes(att),
          mimeType: att.mimeType,
          name: att.fileName ?? DEFAULT_ATTACHMENT_NAME,
        }),
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
    client.startWatching({
      onMessage: async (message) => {
        try {
          for (const m of await toMessages(message)) {
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
      await writeFile(tmp, content.data);
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
