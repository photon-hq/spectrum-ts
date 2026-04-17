import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import type { Content } from "../../content/types";
import { type ManagedStream, stream } from "../../utils/stream";
import type { IMessageMessage } from "./types";

const toSpace = (message: LocalIMessage): IMessageMessage["space"] => ({
  id: message.chatId,
  type: message.chatKind === "group" ? "group" : "dm",
});

const toMessage = (message: LocalIMessage): IMessageMessage => ({
  id: message.id,
  content: { type: "text", text: message.text ?? "" },
  sender: { id: message.participant ?? "" },
  space: toSpace(message),
  timestamp: message.createdAt,
});

export const messages = (client: IMessageSDK): ManagedStream<IMessageMessage> =>
  stream((emit) => {
    client.startWatching({
      onMessage: (message) => emit(toMessage(message)),
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
