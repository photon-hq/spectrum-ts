import type {
  Content,
  FusorMessagesCtx,
  Message as SpectrumMessage,
  Store,
} from "@spectrum-ts/core";
import {
  asCustom,
  asEdit,
  asGroup,
  asPollOption,
  asReaction,
  asText,
  asUnsend,
  type BaseContent,
  type ProviderMessageRecord,
} from "@spectrum-ts/core/authoring";
import {
  acknowledgeComponentInteraction,
  discordClient,
  getChannelMessage,
} from "../client";
import type { DiscordConfig } from "../config";
import {
  type DiscordPayload,
  type DiscordUser,
  DispatchEvent,
  type Interaction,
  InteractionType,
  type MessageCreate,
  type MessageDelete,
  type MessagePollVoteAdd,
  type MessagePollVoteRemove,
  type MessageReactionAdd,
  type MessageReactionRemove,
  type MessageUpdate,
} from "../types";
import { attachmentToContent } from "./media";
import {
  optionForAnswerId,
  type ReconstructedPoll,
  reconstructPoll,
} from "./poll";

// A poll's reconstructed shape is cached in the platform store under this key,
// keyed by the poll message's id, so the first vote fetches the message once and
// later votes resolve their option without another REST round-trip.
const pollCacheKey = (messageId: string): string => `poll:${messageId}`;

// Inbound items are not full Messages yet — core's wrapProviderMessage inflates
// them. A minimal `{ id, content }` shape satisfies the `isMessage` guard used
// for group items and reaction targets.
const stubMessage = (id: string, content: Content): SpectrumMessage =>
  ({ id, content }) as unknown as SpectrumMessage;

const senderRef = (user: DiscordUser) => ({
  id: user.id,
  handle: user.username,
  isMe: false,
});

// A Discord message can carry text and several attachments at once. Surface a
// single content when there's only one, or a `group` of [text, ...files] that
// `flattenGroups` splits back into one message per part downstream.
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

// Map a message's text + attachments to Spectrum content parts: the trimmed
// `content` as a leading text part (if any) followed by one part per attachment.
const messageToContents = (
  msg: Pick<MessageCreate, "attachments" | "content">
): Content[] => {
  const contents: Content[] = [];
  const text = msg.content.trim();
  if (text.length > 0) {
    contents.push(asText(text));
  }
  for (const file of msg.attachments) {
    contents.push(attachmentToContent(file));
  }
  return contents;
};

const fromMessage = (
  msg: MessageCreate,
  config: DiscordConfig,
  store?: Store
): ProviderMessageRecord | undefined => {
  // Drop the bot's own messages so it never echoes itself. A bot's user id
  // equals its application id.
  if (msg.author.id === config.applicationId) {
    return;
  }
  const contents = messageToContents(msg);
  // A poll message surfaces as `poll` content. Cache the reconstruction so a
  // later vote on this poll resolves its option without re-fetching the message.
  if (msg.poll) {
    const reconstructed = reconstructPoll(msg.poll);
    if (reconstructed) {
      contents.push(reconstructed.poll);
      store?.set(pollCacheKey(msg.id), reconstructed);
    }
  }
  const content = toRecordContent(contents, msg.id);
  if (!content) {
    return;
  }
  return {
    id: msg.id,
    content,
    sender: senderRef(msg.author),
    space: { id: msg.channel_id },
    timestamp: new Date(msg.timestamp),
  };
};

const fromMessageUpdate = (
  msg: MessageUpdate,
  config: DiscordConfig
): ProviderMessageRecord | undefined => {
  // Discord also fires MESSAGE_UPDATE for partial changes it makes itself (e.g.
  // auto-attaching a link embed), where no author is present. Without an author
  // there's nothing to attribute the edit to, so ignore it. Then drop the bot's
  // own edits so it never re-ingests messages it sent.
  if (!msg.author || msg.author.id === config.applicationId) {
    return;
  }
  const content = toRecordContent(messageToContents(msg), msg.id);
  if (!content) {
    return;
  }
  // The edited message is the sender's own message, so tag the target stub
  // `inbound` — otherwise wrapProviderMessage defaults an edit target to
  // outbound (the usual case, where we're rewriting one of our own messages).
  const target = {
    id: msg.id,
    content: asCustom({ discord: "edit-target" }),
    direction: "inbound",
  } as unknown as SpectrumMessage;
  // MESSAGE_UPDATE reuses the original message id, so synthesize a distinct
  // event id (mirroring reactions) to keep the edit from colliding with the
  // MESSAGE_CREATE it amends.
  return {
    id: `edit:${msg.channel_id}:${msg.id}`,
    content: asEdit({ content: content as BaseContent, target }),
    sender: senderRef(msg.author),
    space: { id: msg.channel_id },
    timestamp: new Date(msg.edited_timestamp ?? Date.now()),
  };
};

// Discord reaction events assign no event id, so synthesize a stable one from
// the actor, target and emoji. Add and remove derive the same id for a given
// reaction so a removal's `unsend` resolves back to the reaction it retracts.
const reactionEventId = (
  reaction: MessageReactionAdd | MessageReactionRemove,
  emoji: string
): string =>
  `reaction:${reaction.channel_id}:${reaction.message_id}:${reaction.user_id}:${emoji}`;

const fromReaction = (
  reaction: MessageReactionAdd,
  config: DiscordConfig
): ProviderMessageRecord | undefined => {
  // Ignore the bot's own reactions (mirrors dropping its own messages).
  if (reaction.user_id === config.applicationId) {
    return;
  }
  const emoji = reaction.emoji.name;
  if (!emoji) {
    return; // Custom emoji with no name — nothing to surface.
  }
  const target = stubMessage(
    reaction.message_id,
    asCustom({ discord: "reaction-target" })
  );
  // Discord reaction events carry only the reactor and target, not the original
  // author, so the synthesized sender is the reactor.
  return {
    id: reactionEventId(reaction, emoji),
    content: asReaction({ emoji, target }),
    sender: { id: reaction.user_id, isMe: false },
    space: { id: reaction.channel_id },
    timestamp: new Date(),
  };
};

const fromReactionRemove = (
  reaction: MessageReactionRemove,
  config: DiscordConfig
): ProviderMessageRecord | undefined => {
  // Mirror fromReaction: ignore the bot's own reaction removals and custom
  // emoji with no name.
  if (reaction.user_id === config.applicationId) {
    return;
  }
  const emoji = reaction.emoji.name;
  if (!emoji) {
    return; // Custom emoji with no name — nothing to surface.
  }
  // Removing a reaction retracts it, so map it to an `unsend` whose target is
  // the reaction the add handler surfaced. Reuse that handler's synthesized id
  // (via reactionEventId) so the unsend resolves to the same reaction, and tag
  // the stub `inbound` since it's the user's own reaction (not one of ours).
  const target = {
    id: reactionEventId(reaction, emoji),
    content: asCustom({ discord: "unsend-target" }),
    direction: "inbound",
  } as unknown as SpectrumMessage;
  return {
    id: `reaction-remove:${reaction.channel_id}:${reaction.message_id}:${reaction.user_id}:${emoji}`,
    content: asUnsend({ target }),
    sender: { id: reaction.user_id, isMe: false },
    space: { id: reaction.channel_id },
    timestamp: new Date(),
  };
};

const fromMessageDelete = (msg: MessageDelete): ProviderMessageRecord => {
  // MESSAGE_DELETE carries only the id of the removed message — no author or
  // content — so map it to an `unsend` retracting that message. Tag the target
  // stub `inbound` (mirroring the edit target) since it's the user's own
  // message rather than one of ours.
  const target = {
    id: msg.id,
    content: asCustom({ discord: "unsend-target" }),
    direction: "inbound",
  } as unknown as SpectrumMessage;
  // The delete reuses the original message id, so synthesize a distinct event
  // id to keep it from colliding with the MESSAGE_CREATE it retracts.
  return {
    id: `delete:${msg.channel_id}:${msg.id}`,
    content: asUnsend({ target }),
    space: { id: msg.channel_id },
    timestamp: new Date(),
  };
};

// Resolve a poll's reconstructed shape for a vote: the platform store first,
// then a one-off message fetch on a miss (Discord poll-vote dispatches carry no
// poll structure). A successful fetch is cached so sibling votes skip the round
// trip. Returns `undefined` when the message has no usable poll.
const resolveReconstructedPoll = async (
  config: DiscordConfig,
  channelId: string,
  messageId: string,
  store?: Store
): Promise<ReconstructedPoll | undefined> => {
  const cached = store?.object<ReconstructedPoll>(pollCacheKey(messageId));
  if (cached) {
    return cached;
  }
  const message = await getChannelMessage(
    discordClient(config),
    channelId,
    messageId
  );
  if (!message.poll) {
    return;
  }
  const reconstructed = reconstructPoll(message.poll);
  if (reconstructed) {
    store?.set(pollCacheKey(messageId), reconstructed);
  }
  return reconstructed;
};

// Map a poll-vote dispatch to a `poll_option`. `selected` is true for an added
// vote and false for a removed one — Discord poll votes have a natural
// "unselected" state, so a removal stays a `poll_option` (preserving which
// option was unvoted) rather than collapsing to an `unsend`. Add and remove use
// distinct event ids since each is an independent record.
const fromPollVote = async (
  vote: MessagePollVoteAdd | MessagePollVoteRemove,
  config: DiscordConfig,
  selected: boolean,
  store?: Store
): Promise<ProviderMessageRecord | undefined> => {
  // Ignore the bot's own votes (mirrors dropping its own messages/reactions).
  if (vote.user_id === config.applicationId) {
    return;
  }
  const reconstructed = await resolveReconstructedPoll(
    config,
    vote.channel_id,
    vote.message_id,
    store
  );
  if (!reconstructed) {
    return;
  }
  const choice = optionForAnswerId(reconstructed, vote.answer_id);
  if (!choice) {
    return;
  }
  const action = selected ? "add" : "remove";
  return {
    id: `poll-vote-${action}:${vote.channel_id}:${vote.message_id}:${vote.user_id}:${vote.answer_id}`,
    content: asPollOption({
      option: choice,
      poll: reconstructed.poll,
      selected,
    }),
    sender: { id: vote.user_id, isMe: false },
    space: { id: vote.channel_id },
    timestamp: new Date(),
  };
};

// Map an INTERACTION_CREATE (a button click or select-menu submit) to a Spectrum
// message. v1 handles only component interactions; slash commands, autocomplete
// and modal submits are separate features. The interaction is acknowledged within
// Discord's 3-second window before anything else — DEFERRED_UPDATE_MESSAGE acks
// silently (no spinner, source message unchanged), so a reply the handler sends
// is an ordinary channel message. The click itself has no universal analog, so it
// is surfaced as `custom` content (like the outbound `embed`/`components`) that a
// handler narrows on: `raw.discord.type === "interaction"`. `interaction_id`/
// `token` ride along so a future explicit-response API (edit the source message,
// ephemeral reply, open a modal) can use them; v1 has already acked.
const fromInteraction = async (
  interaction: Interaction,
  config: DiscordConfig
): Promise<ProviderMessageRecord | undefined> => {
  if (interaction.type !== InteractionType.MESSAGE_COMPONENT) {
    return;
  }
  // Ack first — even if we end up not surfacing the click below, the user must
  // never see "interaction failed" in the UI.
  await acknowledgeComponentInteraction(
    discordClient(config),
    interaction.id,
    interaction.token
  );
  // The actor is the guild member's user in a server, or the bare user in a DM.
  const actor = interaction.member?.user ?? interaction.user;
  // Drop the bot's own interactions (mirrors the message/reaction self-filters),
  // though a bot never triggers a component interaction in practice.
  if (!actor || actor.id === config.applicationId) {
    return;
  }
  const customId = interaction.data?.custom_id;
  // A component interaction always carries both a custom_id and the channel it
  // fired in; bail if either is somehow absent (nothing to route or attribute to).
  if (!(customId && interaction.channel_id)) {
    return;
  }
  return {
    id: `interaction:${interaction.id}`,
    content: asCustom({
      discord: {
        type: "interaction",
        component_type: interaction.data?.component_type,
        custom_id: customId,
        values: interaction.data?.values,
        message_id: interaction.message?.id,
        interaction_id: interaction.id,
        token: interaction.token,
      },
    }),
    sender: senderRef(actor),
    space: { id: interaction.channel_id },
    timestamp: new Date(),
  };
};

/**
 * Map a relayed Discord Gateway dispatch to the Spectrum message it represents.
 * v1 surfaces new messages (text + attachments, fanned out as a group; a `poll`
 * message surfaces as `poll` content), edits (`MESSAGE_UPDATE`, mapped to an
 * `edit` rewriting the original message), and emoji reactions
 * (`MESSAGE_REACTION_ADD`). Deletes (`MESSAGE_DELETE`) and reaction removals
 * (`MESSAGE_REACTION_REMOVE`) map to `unsend`s retracting the message or
 * reaction. Poll votes (`MESSAGE_POLL_VOTE_ADD`/`MESSAGE_POLL_VOTE_REMOVE`) map
 * to `poll_option` (`selected` true/false) and resolve asynchronously, fetching
 * the poll message when it is not already cached. Component interactions
 * (`INTERACTION_CREATE` of type `MESSAGE_COMPONENT` — a button click or
 * select-menu submit) are acknowledged within Discord's 3-second window and
 * surfaced as `custom` content. Typing, presence and every other dispatch type
 * are ignored (return `undefined`).
 */
export const handleMessages = ({
  payload,
  config,
  store,
}: FusorMessagesCtx<DiscordPayload, DiscordConfig>):
  | ProviderMessageRecord
  | Promise<ProviderMessageRecord | undefined>
  | undefined => {
  switch (payload.t) {
    case DispatchEvent.MESSAGE_CREATE:
      return fromMessage(payload.d as MessageCreate, config, store);
    case DispatchEvent.MESSAGE_UPDATE:
      return fromMessageUpdate(payload.d as MessageUpdate, config);
    case DispatchEvent.MESSAGE_DELETE:
      return fromMessageDelete(payload.d as MessageDelete);
    case DispatchEvent.MESSAGE_REACTION_ADD:
      return fromReaction(payload.d as MessageReactionAdd, config);
    case DispatchEvent.MESSAGE_REACTION_REMOVE:
      return fromReactionRemove(payload.d as MessageReactionRemove, config);
    case DispatchEvent.MESSAGE_POLL_VOTE_ADD:
      return fromPollVote(payload.d as MessagePollVoteAdd, config, true, store);
    case DispatchEvent.MESSAGE_POLL_VOTE_REMOVE:
      return fromPollVote(
        payload.d as MessagePollVoteRemove,
        config,
        false,
        store
      );
    case DispatchEvent.INTERACTION_CREATE:
      return fromInteraction(payload.d as Interaction, config);
    default:
      return;
  }
};
