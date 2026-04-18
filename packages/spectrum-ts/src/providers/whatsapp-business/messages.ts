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

const toMessage = (
  client: WhatsAppClient,
  msg: InboundMessage
): WhatsAppMessage => ({
  id: msg.id,
  content: mapContent(client, msg.content),
  sender: { id: msg.from },
  space: { id: msg.from },
  timestamp: msg.timestamp,
});

const mapContent = (
  client: WhatsAppClient,
  content: InboundMessage["content"]
): Content => {
  switch (content.type) {
    case "text":
      return asText(content.body);
    case "image":
    case "video":
    case "audio":
    case "document":
      return lazyMedia(client, content.media);
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

const fetchMedia = async (
  client: WhatsAppClient,
  mediaId: string
): Promise<Response> => {
  const { url } = await client.media.getUrl(mediaId);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`);
  }
  return response;
};

const lazyMedia = (
  client: WhatsAppClient,
  media: { id: string; mimeType: string; filename?: string }
): Content =>
  asAttachment({
    name: media.filename ?? `media-${media.id}`,
    mimeType: media.mimeType,
    read: async () =>
      Buffer.from(await (await fetchMedia(client, media.id)).arrayBuffer()),
    stream: async () => {
      const response = await fetchMedia(client, media.id);
      if (!response.body) {
        throw new Error("Media response missing body");
      }
      return response.body;
    },
  });

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
          emit(toMessage(client, event.message));
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
        file: await content.read(),
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
        file: await content.read(),
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
