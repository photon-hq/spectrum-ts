import {
  type AdvancedIMessage,
  chatGuid,
  type MessageEvent,
  messageGuid,
  Reaction,
} from "@photon-ai/advanced-imessage";
import { asAttachment } from "../../content/attachment";
import { asContact } from "../../content/contact";
import { asCustom } from "../../content/custom";
import { asRichlink } from "../../content/richlink";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import type { SendResult } from "../../platform/types";
import { ensureM4a } from "../../utils/audio";
import { UnsupportedError } from "../../utils/errors";
import { type ManagedStream, mergeStreams, stream } from "../../utils/stream";
import { fromVCard, toVCard } from "../../utils/vcard";
import type { IMessageMessage } from "./types";

const PLATFORM = "iMessage";

// The balloonBundleId Apple stamps on messages whose sole purpose is to
// render a URL preview card. Lives on the proto-level message only —
// the public `Message$1` type does not expose it, so we reach through
// `_raw`. Other plugin bundles (Find My, Digital Touch, Apple Pay) use
// different ids and are intentionally not matched here.
const URL_BALLOON_BUNDLE_ID = "com.apple.messages.URLBalloonProvider";

const unsupportedContent = (type: string): UnsupportedError =>
  UnsupportedError.content(type, PLATFORM);

const toSendResult = (receipt: { guid: unknown }): SendResult => ({
  id: receipt.guid as string,
  timestamp: new Date(),
});

const VCARD_MIME_TYPES: ReadonlySet<string> = new Set([
  "text/vcard",
  "text/x-vcard",
  "text/directory",
  "application/vcard",
  "application/x-vcard",
]);

const isVCardAttachment = (
  mimeType: string | undefined,
  fileName: string | undefined
): boolean => {
  if (mimeType && VCARD_MIME_TYPES.has(mimeType.toLowerCase())) {
    return true;
  }
  return Boolean(fileName?.toLowerCase().endsWith(".vcf"));
};

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

const toAttachmentContent = (
  client: AdvancedIMessage,
  info: ReceivedEvent["message"]["attachments"][number]
): Content =>
  asAttachment({
    name: info.fileName,
    mimeType: info.mimeType,
    size: info.totalBytes,
    read: async () =>
      Buffer.from(await client.attachments.downloadBuffer(info.guid)),
    stream: async () => client.attachments.download(info.guid).stream,
  });

const toVCardContent = async (
  client: AdvancedIMessage,
  info: ReceivedEvent["message"]["attachments"][number]
): Promise<Content> => {
  try {
    const buf = Buffer.from(await client.attachments.downloadBuffer(info.guid));
    return asContact(fromVCard(buf.toString("utf8")));
  } catch {
    return toAttachmentContent(client, info);
  }
};

const getBalloonBundleId = (
  message: ReceivedEvent["message"]
): string | undefined => {
  const raw = (message as { _raw?: { balloonBundleId?: unknown } })._raw;
  const id = raw?.balloonBundleId;
  return typeof id === "string" ? id : undefined;
};

const toRichlinkMessage = (
  event: ReceivedEvent,
  base: Omit<IMessageMessage, "id" | "content">,
  id: string
): IMessageMessage => {
  const url = event.message.text ?? "";
  try {
    return { ...base, id, content: asRichlink({ url }) };
  } catch {
    return {
      ...base,
      id,
      content: url ? asText(url) : asCustom(event.message),
    };
  }
};

const toMessages = async (
  client: AdvancedIMessage,
  event: ReceivedEvent
): Promise<IMessageMessage[]> => {
  const base = baseMessage(event);
  const messageGuidStr = event.message.guid as string;

  if (getBalloonBundleId(event.message) === URL_BALLOON_BUNDLE_ID) {
    return [toRichlinkMessage(event, base, messageGuidStr)];
  }

  if (event.message.attachments.length > 0) {
    return Promise.all(
      event.message.attachments.map(async (info) => ({
        ...base,
        id: `${messageGuidStr}:${info.guid as string}`,
        content: isVCardAttachment(info.mimeType, info.fileName)
          ? await toVCardContent(client, info)
          : toAttachmentContent(client, info),
      }))
    );
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
    const pump = (async () => {
      try {
        for await (const event of sub) {
          if (event.message.isFromMe) {
            continue;
          }
          for (const message of await toMessages(client, event)) {
            await emit(message);
          }
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return async () => {
      sub.close();
      await pump;
    };
  });
};

const sendVCardAttachment = (
  remote: AdvancedIMessage,
  name: string,
  vcf: string
) =>
  remote.attachments.upload({
    data: Buffer.from(vcf, "utf8"),
    fileName: name,
    mimeType: "text/vcard",
  });

const vcardFileName = (
  contact: Extract<Content, { type: "contact" }>
): string => {
  const base = contact.name?.formatted ?? contact.user?.id ?? "contact";
  return `${base.replace(/[^a-zA-Z0-9_\-.]/g, "_")}.vcf`;
};

const sendContactAttachment = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "contact" }>
) => {
  const vcf = await toVCard(content);
  const upload = await sendVCardAttachment(remote, vcardFileName(content), vcf);
  return upload.guid;
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
): Promise<SendResult> => {
  const remote = clients[0];
  if (!remote) {
    throw new Error("No remote iMessage client available");
  }
  const chat = chatGuid(spaceId);
  switch (content.type) {
    case "text":
      return toSendResult(await remote.messages.send(chat, content.text));
    case "richlink":
      return toSendResult(
        await remote.messages.send(chat, content.url, { richLink: true })
      );
    case "attachment": {
      const attachment = await remote.attachments.upload({
        data: await content.read(),
        fileName: content.name,
        mimeType: content.mimeType,
      });
      return toSendResult(
        await remote.messages.send(chat, "", {
          attachment: attachment.guid,
        })
      );
    }
    case "contact": {
      const attachment = await sendContactAttachment(remote, content);
      return toSendResult(await remote.messages.send(chat, "", { attachment }));
    }
    case "voice": {
      const { buffer } = await ensureM4a(
        await content.read(),
        content.mimeType
      );
      const attachment = await remote.attachments.upload({
        data: buffer,
        fileName: content.name ?? "voice.m4a",
        mimeType: "audio/x-m4a",
      });
      return toSendResult(
        await remote.messages.send(chat, "", {
          attachment: attachment.guid,
          audioMessage: true,
        })
      );
    }
    default:
      throw unsupportedContent(content.type);
  }
};

export const replyToMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string,
  content: Content
): Promise<SendResult> => {
  const remote = clients[0];
  if (!remote) {
    throw new Error("No remote iMessage client available");
  }

  const chat = chatGuid(spaceId);
  const replyTo = messageGuid(msgId);

  switch (content.type) {
    case "text":
      return toSendResult(
        await remote.messages.send(chat, content.text, { replyTo })
      );
    case "richlink":
      return toSendResult(
        await remote.messages.send(chat, content.url, {
          richLink: true,
          replyTo,
        })
      );
    case "attachment": {
      const attachment = await remote.attachments.upload({
        data: await content.read(),
        fileName: content.name,
        mimeType: content.mimeType,
      });
      return toSendResult(
        await remote.messages.send(chat, "", {
          attachment: attachment.guid,
          replyTo,
        })
      );
    }
    case "contact": {
      const attachment = await sendContactAttachment(remote, content);
      return toSendResult(
        await remote.messages.send(chat, "", { attachment, replyTo })
      );
    }
    case "voice": {
      const { buffer } = await ensureM4a(
        await content.read(),
        content.mimeType
      );
      const attachment = await remote.attachments.upload({
        data: buffer,
        fileName: content.name ?? "voice.m4a",
        mimeType: "audio/x-m4a",
      });
      return toSendResult(
        await remote.messages.send(chat, "", {
          attachment: attachment.guid,
          audioMessage: true,
          replyTo,
        })
      );
    }
    default:
      throw unsupportedContent(content.type);
  }
};

export const editMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string,
  content: Content
) => {
  if (content.type !== "text") {
    throw UnsupportedError.content(
      content.type,
      PLATFORM,
      "only text content can be edited"
    );
  }
  const remote = clients[0];
  if (!remote) {
    throw new Error("No remote iMessage client available");
  }
  await remote.messages.edit(
    chatGuid(spaceId),
    messageGuid(msgId),
    content.text
  );
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
