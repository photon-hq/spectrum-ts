import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import { type ManagedStream, stream } from "../../../utils/stream";
import type { IMessageMessage } from "../types";
import { localAttachmentContent } from "./attachments";

export const toMessages = async (
  message: LocalIMessage
): Promise<IMessageMessage[]> => {
  const { chatId, chatKind } = message;
  if (!chatId || chatKind === "unknown") {
    return [];
  }

  // Drop rows spectrum's Content union cannot faithfully represent:
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
        content: await localAttachmentContent(att),
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
      // does not wait for the `lastPromise` chain: drain it explicitly to
      // avoid `emit`/attachment reads running past teardown.
      await lastPromise.catch(() => {});
    };
  });
