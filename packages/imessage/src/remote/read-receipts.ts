import type {
  AdvancedIMessage,
  MessageEvent,
} from "@photon-ai/advanced-imessage/grpc";
import { sanitizePhone } from "@photon-ai/otel";
import type { Read as ReadContent } from "@spectrum-ts/core";
import { createLogger, readSchema } from "@spectrum-ts/core/authoring";
import type { MessageCache } from "../cache";
import type { IMessageMessage } from "../types";
import { chatTypeFromGuid, dmPeerFromChatGuid } from "./ids";
import { resolveTargetMessage, toSenderRef } from "./inbound";

const log = createLogger("spectrum.imessage.read");

type ReadEvent = Extract<MessageEvent, { type: "message.read" }>;

/**
 * Synthetic id for a `message.read` event — shared between the stream item
 * (the dedup key across live/catch-up) and the surfaced message. `sequence` is
 * monotonic per line, so N participants reading the same message produce N
 * distinct ids, and the same event replayed through catch-up produces the id
 * it produced live.
 */
export const readReceiptMessageId = (event: ReadEvent): string =>
  `${event.messageGuid}:read:${event.sequence}`;

const asProviderRead = (target: IMessageMessage): ReadContent =>
  readSchema.parse({ target, type: "read" });

/**
 * Identify the reader.
 *
 * `event.actor` is **not** the reader on this arm. Verified against a live
 * line: in a DM where the peer read our message, `actor` came back as *our
 * own* line's address, not theirs. So `actor` is only trusted when it names
 * somebody other than us — the shape a group receipt would need if the
 * platform ever populates it — and otherwise the reader is the DM peer
 * encoded in the chat guid.
 *
 * A group receipt whose actor is us (or absent) is not attributable at all:
 * a group guid carries no participant list. Those are dropped rather than
 * surfaced with a wrong or missing reader, because the reader's identity is
 * the entire payload of a receipt.
 */
const toReader = (
  event: ReadEvent,
  phone: string
): ReturnType<typeof toSenderRef> | undefined => {
  const actor = event.actor;
  if (actor?.address && actor.address !== phone) {
    return toSenderRef(actor);
  }
  const peer = dmPeerFromChatGuid(event.chatGuid);
  return peer ? { id: peer, address: peer } : undefined;
};

/**
 * Convert a `message.read` event into an inbound `read` message — someone read
 * a message the agent sent. `sender` is the reader; `content.target` is ours.
 *
 * Two guards, cheapest first:
 *
 * 1. **No actor -> drop.** Unlike a membership change (where the state change
 *    itself is the payload and `sender: undefined` still carries meaning), the
 *    reader's identity *is* the payload of a receipt. A senderless receipt in a
 *    group is indistinguishable noise and would corrupt any "N of M have read"
 *    tally. Same call as `toReactionMessages`.
 *
 * 2. **The target must be one of ours.** `event.isFromMe` is not trustworthy
 *    here: the proto carries no comment for it on this arm, and it most
 *    plausibly describes the *underlying message* — which for a genuine
 *    receipt is ours, i.e. `true` — so keying self-suppression off it would
 *    suppress every receipt worth surfacing. The durable invariant is that a
 *    peer's receipt always points at a message we sent, so the resolved target
 *    must be `direction: "outbound"`. That one check also suppresses the echo
 *    of our own `chats.markRead()`, which marks *their* inbound messages and
 *    therefore resolves `direction: "inbound"`.
 */
export const toReadReceiptMessages = async (
  client: AdvancedIMessage,
  cache: MessageCache,
  event: ReadEvent,
  phone: string
): Promise<IMessageMessage[]> => {
  const reader = toReader(event, phone);
  if (!reader) {
    log.debug("read receipt dropped: reader could not be identified", {
      "spectrum.imessage.read.message_guid": event.messageGuid,
      "spectrum.imessage.read.sequence": event.sequence,
      "spectrum.imessage.read.chat_guid": event.chatGuid,
      "spectrum.imessage.read.has_actor": event.actor?.address !== undefined,
    });
    return [];
  }

  const target = await resolveTargetMessage(
    client,
    cache,
    event.chatGuid,
    event.messageGuid,
    phone
  );
  if (!target) {
    log.debug("read receipt dropped: target message could not be resolved", {
      "spectrum.imessage.read.message_guid": event.messageGuid,
      "spectrum.imessage.read.sequence": event.sequence,
    });
    return [];
  }
  if (target.direction !== "outbound") {
    // Either our own `chats.markRead()` echoing back (it marks *their*
    // messages) or a receipt for a message we did not send. Neither is a
    // signal a consumer can act on.
    log.debug("read receipt dropped: target is not one of ours", {
      "spectrum.imessage.read.message_guid": event.messageGuid,
      "spectrum.imessage.read.sequence": event.sequence,
      "spectrum.imessage.read.target_direction": target.direction ?? "unset",
    });
    return [];
  }

  // `readAt` is when the reader's device marked it read; `occurredAt` is when
  // the bridge observed the event. Prefer the former — the entire value of a
  // receipt is *when* — and fall back only if an unset proto timestamp decoded
  // to `undefined` despite the non-optional type, the same defensive shape as
  // `dateCreated` in inbound.ts.
  const readAt: Date | undefined = event.readAt;

  log.debug("read receipt surfaced", {
    "spectrum.imessage.read.message_guid": event.messageGuid,
    "spectrum.imessage.read.sequence": event.sequence,
    "spectrum.imessage.read.reader": sanitizePhone(reader.id),
    "spectrum.imessage.read.used_read_at": readAt !== undefined,
  });

  return [
    {
      // No `direction` on the envelope: the stream path defaults provider
      // records to inbound. The *target* keeps its own `direction: "outbound"`,
      // which `wrapProviderMessage` honors via `rawDirection`.
      id: readReceiptMessageId(event),
      content: asProviderRead(target),
      sender: reader,
      space: {
        id: event.chatGuid,
        type: chatTypeFromGuid(event.chatGuid),
        phone,
      },
      timestamp: readAt ?? event.occurredAt,
    },
  ];
};
