import type {
  FileShare,
  SlackClient,
  SlackEvent,
  SlackFile,
  InboundMessage as SlackInboundMessage,
} from "@photon-ai/slack";
import { asAttachment } from "../../content/attachment";
import { asCustom } from "../../content/custom";
import { asReaction, type Reaction } from "../../content/reaction";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import type { ProviderMessageRecord } from "../../platform/types";
import { UnsupportedError } from "../../utils/errors";
import { type ManagedStream, mergeStreams, stream } from "../../utils/stream";
import type { SlackMessage } from "./types";

interface SpaceRef {
  id: string;
  teamId: string;
}

const toRecord = (
  result: { ts: string; channel: string },
  space: SpaceRef,
  content: Content
): ProviderMessageRecord => ({
  id: result.ts,
  content,
  space: { id: result.channel, teamId: space.teamId },
  timestamp: tsToDate(result.ts),
  ts: result.ts,
  isFromMe: true,
});

// files.upload returns one `FileShare` per channel passed in `upload({ channel })`.
// We only upload to a single channel, so pick that one's `ts` for reply/react
// targeting. Falls back to `file.id` if the backend hasn't populated `shares`.
const toUploadRecord = (
  result: { file: SlackFile; shares: readonly FileShare[] },
  space: SpaceRef,
  content: Content
): ProviderMessageRecord => {
  const shareTs = result.shares.find((s) => s.channel === space.id)?.ts;
  return {
    id: shareTs ?? result.file.id,
    content,
    space: { id: space.id, teamId: space.teamId },
    timestamp: shareTs ? tsToDate(shareTs) : new Date(),
    ts: shareTs,
    isFromMe: true,
  };
};

// Slack `ts` values are formatted as `<seconds>.<microseconds>`; parse to a
// Date for the universal Message contract. Falls back to `new Date()` when the
// string is empty (e.g. reactions don't echo a ts).
const tsToDate = (ts: string): Date => {
  if (!ts) {
    return new Date();
  }
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) {
    return new Date();
  }
  return new Date(seconds * 1000);
};

const lazySlackFile = (
  client: SlackClient,
  teamId: string,
  file: SlackFile
): Content =>
  asAttachment({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    read: async () => {
      const { bytes } = await client
        .team(teamId)
        .files.getContentBuffer(file.id);
      return Buffer.from(bytes);
    },
    stream: async () => {
      const { content } = await client.team(teamId).files.getContent(file.id);
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of content) {
              controller.enqueue(chunk);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });
    },
  });

const toMessages = (client: SlackClient, event: SlackEvent): SlackMessage[] => {
  if (event.type === "message") {
    return messageToMessages(client, event.teamId, event.message);
  }
  if (event.type === "reaction") {
    return [reactionToMessage(event.teamId, event.reaction)];
  }
  if (event.type === "mention") {
    return [
      {
        id: event.mention.ts,
        content: asText(event.mention.text),
        sender: { id: event.mention.user },
        space: { id: event.mention.channel, teamId: event.teamId },
        timestamp: tsToDate(event.mention.ts),
        ts: event.mention.ts,
        isFromMe: event.mention.isFromMe,
      },
    ];
  }
  // Interactive callbacks and slash commands are surfaced via the optional
  // `events?` slot (see `index.ts`), not the universal messages stream.
  return [];
};

const messageToMessages = (
  client: SlackClient,
  teamId: string,
  msg: SlackInboundMessage
): SlackMessage[] => {
  const base = {
    sender: { id: msg.user },
    space: { id: msg.channel, teamId },
    timestamp: tsToDate(msg.ts),
    ts: msg.ts,
    threadTs: msg.threadTs,
    subtype: msg.subtype,
    isFromMe: msg.isFromMe,
  };

  // Slack delivers text + files in a single InboundMessage. Surface each as
  // its own emit so downstream consumers see them as distinct messages —
  // mirrors WhatsApp Business's contacts fan-out. The id suffix keeps the
  // per-event ids unique while still pointing back at the parent `ts`.
  const results: SlackMessage[] = [];
  if (msg.text) {
    results.push({
      ...base,
      id: msg.files.length > 0 ? `${msg.ts}:text` : msg.ts,
      content: asText(msg.text),
    });
  }
  for (const [index, file] of msg.files.entries()) {
    const singleFile = msg.files.length === 1 && !msg.text;
    results.push({
      ...base,
      id: singleFile ? msg.ts : `${msg.ts}:file:${index}`,
      content: lazySlackFile(client, teamId, file),
    });
  }
  if (results.length === 0) {
    results.push({
      ...base,
      id: msg.ts,
      content: asCustom({ slack_type: "empty" }),
    });
  }
  return results;
};

const reactionToMessage = (
  teamId: string,
  reaction: {
    isFromMe: boolean;
    itemChannel: string;
    itemTs: string;
    name: string;
    removed: boolean;
    user: string;
  }
): SlackMessage => {
  // Slack reaction events carry only the target message ts/channel and the
  // *reactor*'s user id — not the original message's author. Synthesize a
  // minimal Message shape with an empty-string sender sentinel; core's
  // wrapProviderMessage inflates this into a full Message with react/reply
  // methods at emit time. Consumers that need the real author must look it
  // up via conversations.history (not currently exposed through spectrum).
  const stubTarget = {
    id: reaction.itemTs,
    content: asCustom({ slack_type: "reaction-target", stub: true }),
    sender: { id: "" },
    space: { id: reaction.itemChannel, teamId },
  };
  return {
    id: `${reaction.itemTs}:reaction:${reaction.user}:${reaction.name}`,
    content: asReaction({
      emoji: reaction.name,
      // Cast through unknown: stub is a partial Message; core's
      // wrapProviderMessage inflates the missing react/reply/edit methods.
      target: stubTarget as unknown as Parameters<
        typeof asReaction
      >[0]["target"],
    }),
    sender: { id: reaction.user },
    space: { id: reaction.itemChannel, teamId },
    timestamp: new Date(),
    ts: reaction.itemTs,
    subtype: reaction.removed ? "reaction_removed" : "reaction_added",
    isFromMe: reaction.isFromMe,
  };
};

const teamStream = (
  client: SlackClient,
  teamId: string
): ManagedStream<SlackMessage> => {
  const eventStream = client.team(teamId).events.subscribe();
  return stream<SlackMessage>((emit, end) => {
    const pump = (async () => {
      try {
        for await (const event of eventStream) {
          for (const m of toMessages(client, event)) {
            await emit(m);
          }
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return async () => {
      await eventStream.close();
      await pump;
    };
  });
};

export const messages = (
  client: SlackClient,
  resolveTeamIds: () => Promise<readonly string[]>
): ManagedStream<SlackMessage> =>
  stream<SlackMessage>(async (emit, end) => {
    let teamIds: readonly string[];
    try {
      teamIds = await resolveTeamIds();
    } catch (err) {
      end(err);
      return;
    }
    const merged = mergeStreams(teamIds.map((id) => teamStream(client, id)));
    const pump = (async () => {
      try {
        for await (const value of merged) {
          await emit(value);
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return async () => {
      await merged.close();
      await pump;
    };
  });

const mimeToMediaName = (mimeType: string, fallback: string): string => {
  const slash = mimeType.indexOf("/");
  if (slash < 0) {
    return fallback;
  }
  return `${fallback}.${mimeType.slice(slash + 1)}`;
};

export const send = async (
  client: SlackClient,
  space: SpaceRef,
  content: Content
): Promise<ProviderMessageRecord | undefined> => {
  if (content.type === "reply") {
    return await replyToMessage(
      client,
      space,
      (content.target as { ts?: string }).ts ?? content.target.id,
      content.content
    );
  }
  if (content.type === "reaction") {
    return await reactToMessage(
      client,
      space,
      (content.target as { ts?: string }).ts ?? content.target.id,
      content
    );
  }
  if (content.type === "typing") {
    // Slack's Web API has no typing-indicator RPC. Silently ignore so
    // `space.startTyping()` / `space.responding()` work portably across
    // platforms.
    return;
  }
  return await sendContent(client, space, content);
};

const sendContent = async (
  client: SlackClient,
  space: SpaceRef,
  content: Content,
  threadTs?: string
): Promise<ProviderMessageRecord> => {
  const team = client.team(space.teamId);
  switch (content.type) {
    case "text": {
      const result = await team.messages.send({
        channel: space.id,
        text: content.text,
        threadTs,
      });
      return toRecord(result, space, content);
    }
    case "attachment": {
      const result = await team.files.upload({
        channel: space.id,
        content: await content.read(),
        filename: content.name,
        mimeType: content.mimeType,
        threadTs,
      });
      return toUploadRecord(result, space, content);
    }
    case "voice": {
      const result = await team.files.upload({
        channel: space.id,
        content: await content.read(),
        filename: content.name ?? mimeToMediaName(content.mimeType, "voice"),
        mimeType: content.mimeType,
        threadTs,
      });
      return toUploadRecord(result, space, content);
    }
    default:
      throw UnsupportedError.content(content.type);
  }
};

const reactToMessage = async (
  client: SlackClient,
  space: SpaceRef,
  targetTs: string,
  content: Reaction
): Promise<ProviderMessageRecord> => {
  await client.team(space.teamId).messages.send({
    channel: space.id,
    reaction: {
      emoji: content.emoji,
      itemChannel: space.id,
      itemTs: targetTs,
    },
  });
  // reactions.add echoes an empty `ts`. Mirror the inbound id format
  // (`<itemTs>:reaction:<user>:<name>`); `self` stands in for the bot user
  // id, which the send path doesn't have at hand. `isFromMe` is required by
  // the message extras schema; `ts` mirrors inbound reaction records and is
  // what a future unsend needs to call reactions.remove.
  return {
    id: `${targetTs}:reaction:self:${content.emoji}`,
    content,
    space: { id: space.id, teamId: space.teamId },
    timestamp: new Date(),
    ts: targetTs,
    isFromMe: true,
  };
};

export const replyToMessage = async (
  client: SlackClient,
  space: SpaceRef,
  targetTs: string,
  content: Content
): Promise<ProviderMessageRecord> =>
  await sendContent(client, space, content, targetTs);
