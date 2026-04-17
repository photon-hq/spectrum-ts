import {
  type AdvancedIMessage,
  chatGuid,
  type MessageEvent,
  messageGuid,
  Reaction,
} from "@photon-ai/advanced-imessage";
import { asCustom } from "../../content/custom";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import { type ManagedStream, mergeStreams, stream } from "../../utils/stream";
import type { IMessageMessage } from "./types";

type ReceivedEvent = Extract<MessageEvent, { type: "message.received" }>;

const TAPBACK_NAMES: ReadonlySet<string> = new Set(
  Object.values(Reaction).filter((r) => r !== "emoji" && r !== "sticker")
);

const toMessage = (event: ReceivedEvent): IMessageMessage => {
  const text = event.message.text;
  return {
    id: event.message.guid as string,
    content: text ? asText(text) : asCustom(event.message),
    sender: { id: event.message.sender?.address ?? "" },
    space: {
      id: event.chatGuid,
      type: event.chatGuid.includes(";+;") ? "group" : "dm",
    },
    timestamp: event.timestamp,
  };
};

const clientStream = (
  client: AdvancedIMessage
): ManagedStream<IMessageMessage> => {
  const sub = client.messages.subscribe("message.received");
  return stream<IMessageMessage>((emit, end) => {
    (async () => {
      try {
        for await (const event of sub) {
          emit(toMessage(event));
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
        data: content.data,
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
        data: content.data,
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
