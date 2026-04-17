import type {
  InboundMessage,
  WhatsAppClient,
} from "@photon-ai/whatsapp-business";
import { asAttachment } from "../../content/attachment";
import { asCustom } from "../../content/custom";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import { type ManagedStream, stream } from "../../utils/stream";
import type { WhatsAppMessage } from "./types";

const toMessage = async (
  client: WhatsAppClient,
  msg: InboundMessage
): Promise<WhatsAppMessage> => {
  const content = await mapContent(client, msg.content);
  return {
    id: msg.id,
    content,
    sender: { id: msg.from },
    space: { id: msg.from },
    timestamp: msg.timestamp,
  };
};

const mapContent = async (
  client: WhatsAppClient,
  content: InboundMessage["content"]
): Promise<Content> => {
  switch (content.type) {
    case "text":
      return asText(content.body);
    case "image":
    case "video":
    case "audio":
    case "document":
      return downloadMedia(client, content.media);
    case "sticker":
      return asCustom({ whatsapp_type: "sticker", ...content.sticker });
    case "location":
      return asCustom({ whatsapp_type: "location", ...content.location });
    case "contacts":
      return asCustom({
        whatsapp_type: "contacts",
        contacts: content.contacts,
      });
    case "reaction":
      return asCustom({ whatsapp_type: "reaction", ...content.reaction });
    case "interactive":
      return asCustom({ whatsapp_type: "interactive", ...content.interactive });
    case "button":
      return asCustom({ whatsapp_type: "button", ...content.button });
    case "order":
      return asCustom({ whatsapp_type: "order", ...content.order });
    case "system":
      return asCustom({ whatsapp_type: "system", ...content.system });
    default:
      return asCustom({ whatsapp_type: "unknown" });
  }
};

const downloadMedia = async (
  client: WhatsAppClient,
  media: { id: string; mimeType: string; filename?: string }
): Promise<Content> => {
  try {
    const { url } = await client.media.getUrl(media.id);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Media download failed: ${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    return asAttachment({
      data,
      mimeType: media.mimeType,
      name: media.filename ?? `media-${media.id}`,
    });
  } catch {
    return asCustom({
      whatsapp_type: "media_error",
      mediaId: media.id,
      mimeType: media.mimeType,
    });
  }
};

const mimeToMediaType = (
  mimeType: string
): "image" | "video" | "audio" | "document" => {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "document";
};

export const messages = (
  client: WhatsAppClient
): ManagedStream<WhatsAppMessage> => {
  const eventStream = client.events
    .subscribe()
    .filter(
      (e): e is Extract<typeof e, { type: "message" }> => e.type === "message"
    );

  return stream<WhatsAppMessage>((emit, end) => {
    (async () => {
      try {
        for await (const event of eventStream) {
          const msg = await toMessage(client, event.message);
          emit(msg);
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return () => eventStream.close();
  });
};

export const send = async (
  client: WhatsAppClient,
  spaceId: string,
  content: Content
): Promise<void> => {
  switch (content.type) {
    case "text":
      await client.messages.send({ to: spaceId, text: content.text });
      break;
    case "attachment": {
      const { mediaId } = await client.media.upload({
        file: content.data,
        mimeType: content.mimeType,
        filename: content.name,
      });
      const mediaType = mimeToMediaType(content.mimeType);
      const mediaPayload =
        mediaType === "document"
          ? { id: mediaId, filename: content.name }
          : { id: mediaId };
      await client.messages.send({
        to: spaceId,
        [mediaType]: mediaPayload,
      } as Parameters<typeof client.messages.send>[0]);
      break;
    }
    default:
      break;
  }
};

export const reactToMessage = async (
  client: WhatsAppClient,
  spaceId: string,
  messageId: string,
  reaction: string
): Promise<void> => {
  await client.messages.send({
    to: spaceId,
    reaction: { messageId, emoji: reaction },
  });
};

export const replyToMessage = async (
  client: WhatsAppClient,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<void> => {
  switch (content.type) {
    case "text":
      await client.messages.send({
        to: spaceId,
        replyTo: messageId,
        text: content.text,
      });
      break;
    case "attachment": {
      const { mediaId } = await client.media.upload({
        file: content.data,
        mimeType: content.mimeType,
        filename: content.name,
      });
      const mediaType = mimeToMediaType(content.mimeType);
      const mediaPayload =
        mediaType === "document"
          ? { id: mediaId, filename: content.name }
          : { id: mediaId };
      await client.messages.send({
        to: spaceId,
        replyTo: messageId,
        [mediaType]: mediaPayload,
      } as Parameters<typeof client.messages.send>[0]);
      break;
    }
    default:
      break;
  }
};
