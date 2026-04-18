import {
  type AdvancedIMessage,
  chatGuid,
  type MessageEvent,
  messageGuid,
  Reaction,
} from "@photon-ai/advanced-imessage";
import { asAttachment } from "../../content/attachment";
import { asCustom } from "../../content/custom";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import { type ManagedStream, mergeStreams, stream } from "../../utils/stream";
import type { IMessageMessage } from "./types";

type ReceivedEvent = Extract<MessageEvent, { type: "message.received" }>;

const TAPBACK_NAMES: ReadonlySet<string> = new Set(
  Object.values(Reaction).filter((r) => r !== "emoji" && r !== "sticker")
);

const baseMessage = (
  event: ReceivedEvent
): Omit<IMessageMessage, "id" | "content"> => ({
  sender: { id: event.message.sender?.address ?? "" },
  space: {
    id: event.chatGuid,
    type: event.chatGuid.includes(";+;") ? "group" : "dm",
  },
  timestamp: event.timestamp,
});

const toMessages = (
  client: AdvancedIMessage,
  event: ReceivedEvent
): IMessageMessage[] => {
  const base = baseMessage(event);
  const messageGuidStr = event.message.guid as string;

  if (event.message.attachments.length > 0) {
    return event.message.attachments.map((info) => ({
      ...base,
      id: `${messageGuidStr}:${info.guid as string}`,
      content: asAttachment({
        name: info.fileName,
        mimeType: info.mimeType,
        size: info.totalBytes,
        read: async () =>
          Buffer.from(await client.attachments.downloadBuffer(info.guid)),
        stream: async () => client.attachments.download(info.guid).stream,
      }),
    }));
  }

  const text = event.message.text;
  return [
    {
      ...base,
      id: messageGuidStr,
      content: text ? asText(text) : asCustom(event.message),
    },
  ];
};

const clientStream = (
  client: AdvancedIMessage
): ManagedStream<IMessageMessage> => {
  const sub = client.messages.subscribe("message.received");
  return stream<IMessageMessage>((emit, end) => {
    (async () => {
      try {
        for await (const event of sub) {
          for (const message of toMessages(client, event)) {
            emit(message);
          }
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return () => sub.close();
  });
};

export const messages = (
  clients: AdvancedIMessage[]
): ManagedStream<IMessageMessage> => mergeStreams(clients.map(clientStream));

export const startTyping = async (
  clients: AdvancedIMessage[],
  spaceId: string
) => {
  const remote = clients[0];
  if (!remote) {
    return;
  }
  await remote.chats.startTyping(chatGuid(spaceId));
};

export const stopTyping = async (
  clients: AdvancedIMessage[],
  spaceId: string
) => {
  const remote = clients[0];
  if (!remote) {
    return;
  }
  await remote.chats.stopTyping(chatGuid(spaceId));
};

export const send = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  content: Content
) => {
  const remote = clients[0];
  if (!remote) {
    return;
  }
  switch (content.type) {
    case "text":
      await remote.messages.send(chatGuid(spaceId), content.text);
      break;
    case "attachment": {
      const attachment = await remote.attachments.upload({
        data: await content.read(),
        fileName: content.name,
        mimeType: content.mimeType,
      });
      await remote.messages.send(chatGuid(spaceId), "", {
        attachment: attachment.guid,
      });
      break;
    }
    default:
      throw new Error(`Unsupported iMessage content type: ${content.type}`);
  }
};

export const replyToMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string,
  content: Content
) => {
  const remote = clients[0];
  if (!remote) {
    return;
  }

  const chat = chatGuid(spaceId);
  const replyTo = messageGuid(msgId);

  switch (content.type) {
    case "text":
      await remote.messages.send(chat, content.text, { replyTo });
      break;
    case "attachment": {
      const attachment = await remote.attachments.upload({
        data: await content.read(),
        fileName: content.name,
        mimeType: content.mimeType,
      });
      await remote.messages.send(chat, "", {
        attachment: attachment.guid,
        replyTo,
      });
      break;
    }
    default:
      throw new Error(`Unsupported iMessage content type: ${content.type}`);
  }
};

export const reactToMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string,
  reaction: string
) => {
  const remote = clients[0];
  if (!remote) {
    return;
  }

  const chat = chatGuid(spaceId);
  const msg = messageGuid(msgId);

  if (TAPBACK_NAMES.has(reaction)) {
    await remote.messages.react(chat, msg, reaction as Reaction);
  } else {
    await remote.messages.reactEmoji(chat, msg, reaction);
  }
};
