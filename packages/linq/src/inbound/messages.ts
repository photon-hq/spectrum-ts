import type { Content, Message } from "spectrum-ts";
import {
  asCustom,
  asGroup,
  asReaction,
  type ProviderMessageRecord,
} from "spectrum-ts/authoring";
import { tapbackToEmoji } from "../reactions";
import type {
  ChatHandle,
  LinqPayload,
  MessageEventV2,
  ReactionEventBase,
} from "../types";
import { partToContent } from "./media";

// Inbound items are not full Messages yet — core's wrapProviderMessage inflates
// them. A minimal `{ id, content }` shape satisfies the `isMessage` guard used
// for group items and reaction targets.
const stubMessage = (id: string, content: Content): Message =>
  ({ id, content }) as unknown as Message;

const senderRef = (handle: ChatHandle) => ({
  id: handle.id,
  handle: handle.handle,
  isMe: handle.is_me ?? false,
  service: handle.service,
});

// One LinQ message can carry several parts. A single part maps to its content
// directly; multiple parts bundle into a `group` (which `flattenGroups` can
// split back into one message per part downstream).
const toRecordContent = (
  contents: Content[],
  messageId: string
): Content | undefined => {
  if (contents.length === 0) {
    return;
  }
  if (contents.length === 1) {
    return contents[0];
  }
  return asGroup({
    items: contents.map((content, index) =>
      stubMessage(`${messageId}:${index}`, content)
    ),
  });
};

const fromMessageReceived = (
  data: MessageEventV2
): ProviderMessageRecord | undefined => {
  const content = toRecordContent(data.parts.map(partToContent), data.id);
  if (!content) {
    return;
  }
  return {
    id: data.id,
    content,
    sender: senderRef(data.sender_handle),
    space: { id: data.chat.id },
    ...(data.sent_at ? { timestamp: new Date(data.sent_at) } : {}),
  };
};

const fromReactionAdded = (
  data: ReactionEventBase,
  eventId: string
): ProviderMessageRecord | undefined => {
  const emoji = tapbackToEmoji(data.reaction_type, data.custom_emoji);
  if (!(emoji && data.message_id && data.chat_id)) {
    return;
  }
  const target = stubMessage(
    data.message_id,
    asCustom({ linq: "reaction-target" })
  );
  // `from_handle` is optional: when LinQ omits it the reaction resolves to a
  // message with no `sender` (Spectrum allows senderless inbound).
  return {
    id: eventId,
    content: asReaction({ emoji, target }),
    ...(data.from_handle ? { sender: senderRef(data.from_handle) } : {}),
    space: { id: data.chat_id },
    ...(data.reacted_at ? { timestamp: new Date(data.reacted_at) } : {}),
  };
};

const fromTyping = (
  chatId: string,
  eventId: string,
  state: "start" | "stop"
): ProviderMessageRecord => ({
  id: eventId,
  content: { type: "typing", state },
  space: { id: chatId },
});

/**
 * Map a verified LinQ webhook event to the Spectrum message(s) Spectrum
 * delivers. Only events that carry a meaningful inbound signal are surfaced:
 * received messages, added reactions, and typing indicators. Typing indicators
 * (and reactions LinQ sends without a `from_handle`) resolve to messages with no
 * `sender` — Spectrum allows senderless inbound. Status, edit, group-metadata,
 * participant, call, and phone-number events are ignored (return `undefined`) —
 * including `message.sent`, which echoes our own sends.
 */
export const handleMessages = ({
  payload,
}: {
  payload: LinqPayload;
}): ProviderMessageRecord | undefined => {
  switch (payload.event_type) {
    case "message.received":
      return fromMessageReceived(payload.data as MessageEventV2);
    case "reaction.added":
      return fromReactionAdded(
        payload.data as ReactionEventBase,
        payload.event_id
      );
    case "chat.typing_indicator.started":
      return fromTyping(
        (payload.data as { chat_id: string }).chat_id,
        payload.event_id,
        "start"
      );
    case "chat.typing_indicator.stopped":
      return fromTyping(
        (payload.data as { chat_id: string }).chat_id,
        payload.event_id,
        "stop"
      );
    default:
      return;
  }
};
