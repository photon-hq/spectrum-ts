import type {
  AdvancedIMessage,
  MessageEvent,
} from "@photon-ai/advanced-imessage/http";
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
 * (the dedup key across live/catch-up) and the surfaced message. The transport
 * may supply the exact decimal source sequence separately because the SDK's
 * numeric event sequence cannot represent every int64. It is monotonic per
 * line, so N participants reading the same message produce N distinct ids and
 * replay produces the same id.
 */
export const readReceiptMessageId = (
  event: ReadEvent,
  sourceSequence = String(event.sequence)
): string => `${event.messageGuid}:read:${sourceSequence}`;

const asProviderRead = (target: IMessageMessage): ReadContent =>
  readSchema.parse({ target, type: "read" });

/**
 * Whether the reader could be identified at all, decided without resolving
 * the target. A DM always can (the peer is in the guid); a group only if the
 * platform named an actor. Lets an unattributable group receipt drop before
 * paying for an RPC.
 */
const isAttributable = (event: ReadEvent): boolean =>
  dmPeerFromChatGuid(event.chatGuid) !== undefined ||
  event.actor?.address !== undefined;

/**
 * Identify the reader.
 *
 * `event.actor` is **not** the reader on this arm. Verified against a live
 * line: in a DM where the peer read our message, `actor` came back as *our
 * own* line's address, not theirs.
 *
 * So the chat guid comes first. In a DM there are exactly two participants
 * and the target is already known to be ours, which makes the reader
 * definitionally the other one — no address comparison needed, and therefore
 * correct on pooled lines too, where `phone` is the `"shared"` sentinel and
 * comparing it against a real address is meaningless.
 *
 * A group guid carries no participant list, so there `actor` is the only
 * possible attribution. It is trusted only when it names neither this line
 * nor the target's own sender; the latter is what catches the shared-mode
 * case, since the sentinel never equals a real address. An unattributable
 * receipt is dropped rather than surfaced with a wrong reader — the reader's
 * identity is the entire payload.
 */
const toReader = (
  event: ReadEvent,
  target: IMessageMessage,
  phone: string
): ReturnType<typeof toSenderRef> | undefined => {
  const peer = dmPeerFromChatGuid(event.chatGuid);
  if (peer) {
    return { id: peer, address: peer };
  }
  const actor = event.actor;
  if (
    actor?.address &&
    actor.address !== phone &&
    actor.address !== target.sender?.address
  ) {
    return toSenderRef(actor);
  }
  return;
};

/**
 * Convert a `message.read` event into an inbound `read` message — someone read
 * a message the agent sent. `sender` is the reader; `content.target` is ours.
 *
 * Two guards, cheapest first:
 *
 * 1. **The reader must be identifiable -> else drop.** Unlike a membership
 *    change (where the state change itself is the payload and
 *    `sender: undefined` still carries meaning), the reader's identity *is*
 *    the payload of a receipt. An unattributed receipt in a group is
 *    indistinguishable noise and would corrupt any "N of M have read" tally.
 *    Same call as `toReactionMessages`. See `toReader`.
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
  phone: string,
  sourceSequence = String(event.sequence)
): Promise<IMessageMessage[]> => {
  if (!isAttributable(event)) {
    log.debug("read receipt dropped: reader could not be identified", {
      "spectrum.imessage.read.message_guid": event.messageGuid,
      "spectrum.imessage.read.sequence": event.sequence,
      "spectrum.imessage.read.chat_guid": event.chatGuid,
      "spectrum.imessage.read.has_actor": false,
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

  // Resolved after the target: validating a group's `actor` needs the target's
  // own sender to compare against (see `toReader`).
  const reader = toReader(event, target, phone);
  if (!reader) {
    log.debug("read receipt dropped: reader could not be identified", {
      "spectrum.imessage.read.message_guid": event.messageGuid,
      "spectrum.imessage.read.sequence": event.sequence,
      "spectrum.imessage.read.chat_guid": event.chatGuid,
      "spectrum.imessage.read.has_actor": true,
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
      id: readReceiptMessageId(event, sourceSequence),
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
