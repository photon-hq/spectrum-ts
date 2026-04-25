import {
  type AdvancedIMessage,
  chatGuid,
  type PollInfo as IMessagePollInfo,
  type PollOption as IMessagePollOption,
  type MessageEvent,
  messageGuid,
  type PollChangeDelta,
  type PollEvent,
  Reaction,
} from "@photon-ai/advanced-imessage";
import { asAttachment } from "../../content/attachment";
import { asContact } from "../../content/contact";
import { asCustom } from "../../content/custom";
import { asGroup } from "../../content/group";
import { asPoll, asPollOption, type PollChoice } from "../../content/poll";
import { asReaction } from "../../content/reaction";
import { asRichlink } from "../../content/richlink";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import type { SendResult } from "../../platform/types";
import type { Message } from "../../types/message";
import { ensureM4a } from "../../utils/audio";
import { UnsupportedError } from "../../utils/errors";
import { type ManagedStream, mergeStreams, stream } from "../../utils/stream";
import { fromVCard, toVCard } from "../../utils/vcard";
import {
  type CachedPoll,
  getMessageCache,
  getPollCache,
  type PollCache,
} from "./cache";
import type { IMessageMessage } from "./types";

const PLATFORM = "iMessage";

// The balloonBundleId Apple stamps on messages whose sole purpose is to
// render a URL preview card. Lives on the proto-level message only —
// the public `Message$1` type does not expose it, so we reach through
// `_raw`. Other plugin bundles (Find My, Digital Touch, Apple Pay) use
// different ids and are intentionally not matched here.
const URL_BALLOON_BUNDLE_ID = "com.apple.messages.URLBalloonProvider";

// Attachment-shaped content types are the only members a group may contain
// when sent via iMessage. Anything else surfaces as an UnsupportedError so the
// platform build layer logs a clear warning.
const GROUP_ITEM_ALLOWED: ReadonlySet<Content["type"]> = new Set([
  "attachment",
  "contact",
  "voice",
]);

const unsupportedContent = (type: string, detail?: string): UnsupportedError =>
  UnsupportedError.content(type, PLATFORM, detail);

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
type AppleMessage = ReceivedEvent["message"];
type AppleAttachment = AppleMessage["attachments"][number];

// Emoji ↔ classic tapback (Apple's six fixed reactions). On send, these six
// emoji use the native tapback API; anything else falls through to the
// emoji-reaction API (iOS 17+). On receive, classic tapbacks surface as
// their emoji equivalent so callers never see platform-specific strings.
const EMOJI_TO_TAPBACK: Readonly<Record<string, Reaction>> = {
  "❤️": Reaction.love,
  "👍": Reaction.like,
  "👎": Reaction.dislike,
  "😂": Reaction.laugh,
  "‼️": Reaction.emphasize,
  "❓": Reaction.question,
};

const TAPBACK_TO_EMOJI: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EMOJI_TO_TAPBACK).map(([emoji, kind]) => [kind, emoji])
);

// Apple `associatedMessageType` raw codes (IMItemType):
//   2000–2005 add classic tapback, 2006 add emoji, 2007 add sticker.
//   3000–3007 mirror but *remove* the reaction; we drop removals for now.
const TAPBACK_CODE_TO_KIND: Readonly<Record<string, Reaction>> = {
  "2000": Reaction.love,
  "2001": Reaction.like,
  "2002": Reaction.dislike,
  "2003": Reaction.laugh,
  "2004": Reaction.emphasize,
  "2005": Reaction.question,
  "2006": Reaction.emoji,
  "2007": Reaction.sticker,
};

const isTapbackRemoval = (code: string): boolean => code.startsWith("3");

const resolveReactionEmoji = (
  type: string | undefined,
  emoji: string | undefined
): string | null => {
  if (emoji) {
    return emoji;
  }
  if (!type) {
    return null;
  }
  const kind = TAPBACK_CODE_TO_KIND[type] ?? (type as Reaction);
  return TAPBACK_TO_EMOJI[kind] ?? null;
};

const getAssociatedMessageType = (
  message: AppleMessage
): string | undefined => {
  const direct = (message as { associatedMessageType?: unknown })
    .associatedMessageType;
  if (typeof direct === "string") {
    return direct;
  }
  const raw = (message as { _raw?: { associatedMessageType?: unknown } })._raw;
  const fromRaw = raw?.associatedMessageType;
  return typeof fromRaw === "string" ? fromRaw : undefined;
};

const getBalloonBundleId = (message: AppleMessage): string | undefined => {
  const raw = (message as { _raw?: { balloonBundleId?: unknown } })._raw;
  const id = raw?.balloonBundleId;
  return typeof id === "string" ? id : undefined;
};

// `Message$1` from the SDK (fetched via `messages.get`) lacks the ambient
// chatGuid that inbound events carry; fall back to the first chat the message
// belongs to.
const resolveChatGuid = (
  message: AppleMessage,
  hint: string | undefined
): string => {
  if (hint) {
    return hint;
  }
  const first = message.chatGuids?.[0];
  return (first as unknown as string | undefined) ?? "";
};

const resolveSenderId = (message: AppleMessage): string =>
  message.sender?.address ?? "";

const toAttachmentContent = (
  client: AdvancedIMessage,
  info: AppleAttachment
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
  info: AppleAttachment
): Promise<Content> => {
  try {
    const buf = Buffer.from(await client.attachments.downloadBuffer(info.guid));
    return asContact(fromVCard(buf.toString("utf8")));
  } catch {
    return toAttachmentContent(client, info);
  }
};

const attachmentContent = async (
  client: AdvancedIMessage,
  info: AppleAttachment
): Promise<Content> =>
  isVCardAttachment(info.mimeType, info.fileName)
    ? await toVCardContent(client, info)
    : toAttachmentContent(client, info);

const baseShape = (
  message: AppleMessage,
  chatGuidHint: string | undefined,
  timestamp: Date
): Omit<IMessageMessage, "id" | "content"> => {
  const chat = resolveChatGuid(message, chatGuidHint);
  return {
    sender: { id: resolveSenderId(message) },
    space: {
      id: chat,
      type: chat.includes(";+;") ? "group" : "dm",
    },
    timestamp,
  };
};

const buildAttachmentMessage = async (
  client: AdvancedIMessage,
  base: Omit<IMessageMessage, "id" | "content">,
  info: AppleAttachment,
  id: string,
  partIndex: number,
  parentId?: string
): Promise<IMessageMessage> => {
  const content = await attachmentContent(client, info);
  const msg: IMessageMessage = { ...base, id, content, partIndex };
  if (parentId !== undefined) {
    msg.parentId = parentId;
  }
  return msg;
};

// Rebuilds an `IMessageMessage` (or a group) from an Apple SDK message that
// did not arrive via the live stream. Used on reaction cache miss.
const rebuildFromAppleMessage = async (
  client: AdvancedIMessage,
  message: AppleMessage,
  chatGuidHint?: string
): Promise<IMessageMessage> => {
  const messageGuidStr = message.guid as string;
  const timestamp = message.dateCreated ?? new Date();
  const base = baseShape(message, chatGuidHint, timestamp);

  if (message.attachments.length === 1) {
    const info = message.attachments[0];
    if (!info) {
      throw new Error("Unreachable: attachments.length === 1 but no element");
    }
    return buildAttachmentMessage(client, base, info, messageGuidStr, 0);
  }

  if (message.attachments.length > 1) {
    const items: IMessageMessage[] = [];
    for (let i = 0; i < message.attachments.length; i++) {
      const info = message.attachments[i];
      if (!info) {
        continue;
      }
      items.push(
        await buildAttachmentMessage(
          client,
          base,
          info,
          formatChildId(i, messageGuidStr),
          i,
          messageGuidStr
        )
      );
    }
    return {
      ...base,
      id: messageGuidStr,
      content: asGroup({ items: items as unknown as Message[] }),
    };
  }

  const text = message.text;
  if (getBalloonBundleId(message) === URL_BALLOON_BUNDLE_ID) {
    const url = text ?? "";
    try {
      return { ...base, id: messageGuidStr, content: asRichlink({ url }) };
    } catch {
      return {
        ...base,
        id: messageGuidStr,
        content: url ? asText(url) : asCustom(message),
      };
    }
  }
  return {
    ...base,
    id: messageGuidStr,
    content: text ? asText(text) : asCustom(message),
  };
};

const cacheMessage = (
  cache: ReturnType<typeof getMessageCache>,
  message: IMessageMessage
): void => {
  cache.set(message.id, message);
  if (message.content.type === "group") {
    for (const item of message.content.items as unknown as IMessageMessage[]) {
      cache.set(item.id, item);
    }
  }
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

// Apple prefixes the target guid of a tapback with `p:<partIndex>/` to name a
// specific part of a multi-part message. We reuse the same encoding as
// spectrum-ts group child message ids so that a child id is round-trippable:
// `remote.messages.get(parentGuid)` can always reconstruct the child by
// parsing the index off the front.
const PART_PREFIX = /^p:(\d+)\//;

const formatChildId = (partIndex: number, parentGuid: string): string =>
  `p:${partIndex}/${parentGuid}`;

const parseTapbackTarget = (
  target: string
): { guid: string; partIndex: number } => {
  const match = target.match(PART_PREFIX);
  const guid = target.replace(PART_PREFIX, "");
  const partIndex = match ? Number(match[1]) : 0;
  return { guid, partIndex };
};

const parseChildId = (
  id: string
): { parentGuid: string; partIndex: number } | null => {
  const match = id.match(PART_PREFIX);
  if (!match) {
    return null;
  }
  return {
    parentGuid: id.replace(PART_PREFIX, ""),
    partIndex: Number(match[1]),
  };
};

const resolveReactionTarget = async (
  client: AdvancedIMessage,
  cache: ReturnType<typeof getMessageCache>,
  strippedGuid: string,
  partIndex: number
): Promise<IMessageMessage | undefined> => {
  let candidate = cache.get(strippedGuid);
  if (!candidate) {
    try {
      const fetched = await client.messages.get(messageGuid(strippedGuid));
      candidate = await rebuildFromAppleMessage(client, fetched);
      cacheMessage(cache, candidate);
    } catch {
      return;
    }
  }
  if (candidate.content.type === "group") {
    const item = (candidate.content.items as unknown as IMessageMessage[])[
      partIndex
    ];
    return item ?? candidate;
  }
  return candidate;
};

const toReactionMessage = async (
  client: AdvancedIMessage,
  cache: ReturnType<typeof getMessageCache>,
  event: ReceivedEvent,
  base: Omit<IMessageMessage, "id" | "content">,
  id: string,
  target: string
): Promise<IMessageMessage[]> => {
  const type = getAssociatedMessageType(event.message);
  if (type && isTapbackRemoval(type)) {
    return [];
  }
  const emoji = resolveReactionEmoji(
    type,
    event.message.associatedMessageEmoji
  );
  if (!emoji) {
    return [];
  }
  const { guid: strippedGuid, partIndex } = parseTapbackTarget(target);
  const resolved = await resolveReactionTarget(
    client,
    cache,
    strippedGuid,
    partIndex
  );
  if (!resolved) {
    return [];
  }
  return [
    {
      ...base,
      id,
      content: asReaction({ emoji, target: resolved as unknown as Message }),
    },
  ];
};

const toMessages = async (
  client: AdvancedIMessage,
  cache: ReturnType<typeof getMessageCache>,
  event: ReceivedEvent
): Promise<IMessageMessage[]> => {
  const base = baseShape(event.message, event.chatGuid, event.timestamp);
  const messageGuidStr = event.message.guid as string;

  const assoc = event.message.associatedMessageGuid as string | undefined;
  if (assoc) {
    return toReactionMessage(client, cache, event, base, messageGuidStr, assoc);
  }

  if (getBalloonBundleId(event.message) === URL_BALLOON_BUNDLE_ID) {
    const msg = toRichlinkMessage(event, base, messageGuidStr);
    cacheMessage(cache, msg);
    return [msg];
  }

  if (event.message.attachments.length === 1) {
    const info = event.message.attachments[0];
    if (!info) {
      throw new Error("Unreachable: attachments.length === 1 but no element");
    }
    const msg = await buildAttachmentMessage(
      client,
      base,
      info,
      messageGuidStr,
      0
    );
    cacheMessage(cache, msg);
    return [msg];
  }

  if (event.message.attachments.length > 1) {
    const items: IMessageMessage[] = [];
    for (let i = 0; i < event.message.attachments.length; i++) {
      const info = event.message.attachments[i];
      if (!info) {
        continue;
      }
      items.push(
        await buildAttachmentMessage(
          client,
          base,
          info,
          formatChildId(i, messageGuidStr),
          i,
          messageGuidStr
        )
      );
    }
    const parent: IMessageMessage = {
      ...base,
      id: messageGuidStr,
      content: asGroup({ items: items as unknown as Message[] }),
    };
    cacheMessage(cache, parent);
    return [parent];
  }

  const text = event.message.text;
  const msg: IMessageMessage = {
    ...base,
    id: messageGuidStr,
    content: text ? asText(text) : asCustom(event.message),
  };
  cacheMessage(cache, msg);
  return [msg];
};

type VotedPollEvent = PollEvent & {
  delta: Extract<PollChangeDelta, { type: "voted" }>;
};

type UnvotedPollEvent = PollEvent & {
  delta: Extract<PollChangeDelta, { type: "unvoted" }>;
};

const isVotedPollEvent = (event: PollEvent): event is VotedPollEvent =>
  event.delta.type === "voted";

const isUnvotedPollEvent = (event: PollEvent): event is UnvotedPollEvent =>
  event.delta.type === "unvoted";

const toCachedPoll = (input: {
  options: readonly IMessagePollOption[];
  title: string;
}): CachedPoll => {
  const poll = asPoll({
    title: input.title,
    options: input.options.map((optionInfo) => ({
      title: optionInfo.text,
    })),
  });
  const optionsByIdentifier = new Map<string, PollChoice>();
  for (const [index, optionInfo] of input.options.entries()) {
    const option = poll.options[index];
    if (option && optionInfo.optionIdentifier) {
      optionsByIdentifier.set(optionInfo.optionIdentifier, option);
    }
  }
  return { poll, optionsByIdentifier };
};

const cachePollInfo = (
  cache: PollCache,
  info: IMessagePollInfo
): CachedPoll => {
  const cached = toCachedPoll(info);
  cache.set(info.messageGuid as string, cached);
  return cached;
};

const cachePollEvent = (
  cache: PollCache,
  event: PollEvent
): CachedPoll | undefined => {
  if (event.delta.type === "created" || event.delta.type === "optionAdded") {
    try {
      const cached = toCachedPoll({
        title: event.delta.title,
        options: event.delta.options,
      });
      cache.set(event.pollMessageGuid as string, cached);
      return cached;
    } catch (e) {
      console.error("[spectrum-ts][imessage][poll] failed to cache poll", e);
    }
  }
};

const fetchPollInfo = async (
  client: AdvancedIMessage,
  cache: PollCache,
  event: PollEvent
): Promise<IMessagePollInfo | undefined> => {
  try {
    const info = await client.polls.get(event.pollMessageGuid);
    cachePollInfo(cache, info);
    return info;
  } catch (e) {
    console.error("[spectrum-ts][imessage][poll] failed to fetch poll", e);
    return;
  }
};

const resolvePoll = async (
  client: AdvancedIMessage,
  cache: PollCache,
  event: PollEvent
): Promise<CachedPoll | undefined> => {
  const pollId = event.pollMessageGuid as string;
  const cached = cache.get(pollId);
  if (cached) {
    return cached;
  }
  try {
    const info = await client.polls.get(event.pollMessageGuid);
    return cachePollInfo(cache, info);
  } catch (e) {
    console.error("[spectrum-ts][imessage][poll] failed to resolve poll", e);
    return;
  }
};

const buildPollOptionMessage = (input: {
  cached: CachedPoll;
  chatGuid: string;
  event: Pick<PollEvent, "at" | "pollMessageGuid">;
  optionId: string;
  selected: boolean;
  senderAddress: string;
}): IMessageMessage | undefined => {
  const option = input.cached.optionsByIdentifier.get(input.optionId);
  if (!option) {
    return;
  }
  const action = input.selected ? "selected" : "deselected";
  return {
    id: `${input.event.pollMessageGuid}:${input.senderAddress}:${input.optionId}:${action}:${input.event.at.getTime()}`,
    sender: { id: input.senderAddress },
    space: {
      id: input.chatGuid,
      type: input.chatGuid.includes(";+;") ? "group" : "dm",
    },
    timestamp: input.event.at,
    content: asPollOption({
      option,
      poll: input.cached.poll,
      selected: input.selected,
    }),
  };
};

const buildPollOptionMessages = (input: {
  cached: CachedPoll;
  chatGuid: string;
  deltas: readonly { optionId: string; selected: boolean }[];
  event: Pick<PollEvent, "at" | "pollMessageGuid">;
  senderAddress: string;
}): IMessageMessage[] => {
  const messages: IMessageMessage[] = [];
  for (const delta of input.deltas) {
    const message = buildPollOptionMessage({
      cached: input.cached,
      chatGuid: input.chatGuid,
      event: input.event,
      optionId: delta.optionId,
      selected: delta.selected,
      senderAddress: input.senderAddress,
    });
    if (message) {
      messages.push(message);
    }
  }
  return messages;
};

const allOptionIdsKnown = (
  cached: CachedPoll,
  optionIds: readonly string[]
): boolean =>
  optionIds.every((optionId) => cached.optionsByIdentifier.has(optionId));

const refreshPollMetadata = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: VotedPollEvent,
  fallbackOptionIds: readonly string[]
): Promise<{ optionIds: string[]; poll: CachedPoll } | undefined> => {
  const info = await fetchPollInfo(client, pollCache, event);
  if (!info) {
    return;
  }
  const refreshed = pollCache.get(info.messageGuid as string);
  if (!refreshed) {
    return;
  }
  return {
    optionIds: [...fallbackOptionIds],
    poll: refreshed,
  };
};

const toPollVoteMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: VotedPollEvent
): Promise<IMessageMessage[]> => {
  const senderAddress = event.actor.address;
  if (!senderAddress) {
    return [];
  }
  const pollId = event.pollMessageGuid as string;
  if (pollCache.isStaleActorSelectionEvent(pollId, senderAddress, event.at)) {
    return [];
  }
  const cached = await resolvePoll(client, pollCache, event);
  if (!cached) {
    return [];
  }
  const chatGuidStr = event.chatGuid as string;
  let currentOptionIds = [...event.delta.optionIdentifiers];
  let resolvedPoll = cached;

  if (
    currentOptionIds.some(
      (optionId) => !resolvedPoll.optionsByIdentifier.has(optionId)
    )
  ) {
    const snapshot = await refreshPollMetadata(
      client,
      pollCache,
      event,
      currentOptionIds
    );
    if (snapshot) {
      currentOptionIds = snapshot.optionIds;
      resolvedPoll = snapshot.poll;
    }
  }

  if (!allOptionIdsKnown(resolvedPoll, currentOptionIds)) {
    return [];
  }

  const deltas = pollCache.actorSelectionDeltas(
    pollId,
    senderAddress,
    currentOptionIds
  );
  const messages = buildPollOptionMessages({
    cached: resolvedPoll,
    chatGuid: chatGuidStr,
    deltas,
    event,
    senderAddress,
  });

  pollCache.commitActorSelection(
    pollId,
    senderAddress,
    currentOptionIds,
    event.at
  );

  return messages;
};

const toPollUnvoteMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: UnvotedPollEvent
): Promise<IMessageMessage[]> => {
  const senderAddress = event.actor.address;
  if (!senderAddress) {
    return [];
  }
  const pollId = event.pollMessageGuid as string;
  if (pollCache.isStaleActorSelectionEvent(pollId, senderAddress, event.at)) {
    return [];
  }
  const cached = await resolvePoll(client, pollCache, event);
  if (!cached) {
    return [];
  }
  const chatGuidStr = event.chatGuid as string;
  const messages: IMessageMessage[] = [];
  const deltas = pollCache.clearedActorSelectionDeltas(pollId, senderAddress);
  for (const delta of deltas) {
    const message = buildPollOptionMessage({
      cached,
      chatGuid: chatGuidStr,
      event,
      optionId: delta.optionId,
      selected: delta.selected,
      senderAddress,
    });
    if (message) {
      messages.push(message);
    }
  }
  pollCache.commitActorSelection(pollId, senderAddress, [], event.at);
  return messages;
};

const toPollDeltaMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: PollEvent
): Promise<IMessageMessage[]> => {
  if (isVotedPollEvent(event)) {
    return toPollVoteMessages(client, pollCache, event);
  }
  if (isUnvotedPollEvent(event)) {
    return toPollUnvoteMessages(client, pollCache, event);
  }
  return [];
};

const clientStream = (
  client: AdvancedIMessage,
  pollCache: PollCache
): ManagedStream<IMessageMessage> => {
  const messageSub = client.messages.subscribe("message.received");
  const pollSub = client.polls.subscribe();
  const cache = getMessageCache(client);
  return stream<IMessageMessage>((emit, end) => {
    const messagePump = (async () => {
      try {
        for await (const event of messageSub) {
          if (event.message.isFromMe) {
            continue;
          }
          for (const message of await toMessages(client, cache, event)) {
            await emit(message);
          }
        }
      } catch (e) {
        end(e);
      }
    })();
    const pollPump = (async () => {
      try {
        for await (const event of pollSub) {
          cachePollEvent(pollCache, event);
          if (event.actor.isFromMe) {
            continue;
          }
          const messages = await toPollDeltaMessages(client, pollCache, event);
          for (const vote of messages) {
            await emit(vote);
          }
        }
      } catch (e) {
        // Isolate the poll stream: a failure here (e.g. upstream SDK int64
        // parse errors on SubscribePollEvents) must not kill the message
        // stream. Log and move on — poll_option events simply won't arrive.
        console.error("[spectrum-ts][imessage][poll] stream failed", e);
      }
    })();
    return async () => {
      messageSub.close();
      pollSub.close();
      await Promise.all([messagePump, pollPump]);
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
): ManagedStream<IMessageMessage> => {
  const pollCache = getPollCache(clients);
  return mergeStreams(clients.map((client) => clientStream(client, pollCache)));
};

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

const sendSingle = async (
  remote: AdvancedIMessage,
  chat: ReturnType<typeof chatGuid>,
  content: Content
): Promise<SendResult> => {
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
        await remote.messages.send(chat, "", { attachment: attachment.guid })
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
    case "poll":
      return toSendResult(
        await remote.polls.create(
          chat,
          content.title,
          content.options.map((o) => o.title)
        )
      );
    default:
      throw unsupportedContent(content.type);
  }
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

  if (content.type === "group") {
    // Strict validation — fail before any native send when a group contains
    // items iMessage cannot carry natively.
    for (const sub of content.items as unknown as IMessageMessage[]) {
      const itemType = sub.content.type;
      if (!GROUP_ITEM_ALLOWED.has(itemType)) {
        throw unsupportedContent(
          "group",
          `"${itemType}" items are not supported inside a group`
        );
      }
    }
    // The SDK has no single multi-attachment send with uploaded bytes
    // (MessagePart requires server-side paths; upload returns guids only),
    // so we fall back to N sequential sends. Return per-child receipts on
    // `groupMembers` so the platform layer can build real outbound Messages
    // for each group item. The outer `id` tracks the first child purely for
    // OutboundMessage compatibility — prefer items[i].id for per-item ops.
    const groupMembers: SendResult[] = [];
    for (const sub of content.items as unknown as IMessageMessage[]) {
      groupMembers.push(await sendSingle(remote, chat, sub.content));
    }
    const first = groupMembers[0];
    if (!first) {
      throw new Error("Empty group");
    }
    return { ...first, groupMembers };
  }

  return sendSingle(remote, chat, content);
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
    case "poll":
      throw UnsupportedError.content(
        "poll",
        PLATFORM,
        "polls cannot be sent as replies"
      );
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
  target: IMessageMessage,
  reaction: string
) => {
  const remote = clients[0];
  if (!remote) {
    return;
  }

  const chat = chatGuid(spaceId);
  // A group sub-item carries the parent's guid in `parentId`; top-level
  // messages reuse their own id. Apple's tapback API keys off the parent
  // guid and disambiguates via `partIndex`.
  const parentGuid = target.parentId ?? target.id;
  const guid = messageGuid(parentGuid);
  const opts =
    typeof target.partIndex === "number"
      ? { partIndex: target.partIndex }
      : undefined;

  const native = EMOJI_TO_TAPBACK[reaction];
  if (native) {
    await remote.messages.react(chat, guid, native, opts);
  } else {
    await remote.messages.reactEmoji(chat, guid, reaction, opts);
  }
};

export const getMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string
): Promise<IMessageMessage | undefined> => {
  const remote = clients[0];
  if (!remote) {
    return;
  }
  const cache = getMessageCache(remote);
  const cached = cache.get(msgId);
  if (cached) {
    return cached;
  }

  // Group-child ids use the `p:<partIndex>/<parentGuid>` format (same as
  // Apple tapback targets). The SDK's `messages.get` only accepts parent
  // guids, so decode the id and descend into the parent's items.
  const childRef = parseChildId(msgId);
  if (childRef) {
    try {
      const fetched = await remote.messages.get(
        messageGuid(childRef.parentGuid)
      );
      const parent = await rebuildFromAppleMessage(remote, fetched, spaceId);
      cacheMessage(cache, parent);
      if (parent.content.type !== "group") {
        return;
      }
      const items = parent.content.items as unknown as IMessageMessage[];
      return items[childRef.partIndex];
    } catch {
      return;
    }
  }

  try {
    const fetched = await remote.messages.get(messageGuid(msgId));
    const rebuilt = await rebuildFromAppleMessage(remote, fetched, spaceId);
    cacheMessage(cache, rebuilt);
    return rebuilt;
  } catch {
    return;
  }
};
