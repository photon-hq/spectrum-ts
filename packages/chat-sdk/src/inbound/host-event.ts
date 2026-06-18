// Host-event conversion: turn the chat-SDK host's interactive + lifecycle events
// (button clicks, slash commands, modal submit/close, dynamic-select option
// loads, app-home opens, the Slack assistant surface, channel-membership) into
// inbound Spectrum records. Each surfaces as `custom` content carrying a
// `chatsdk_type` discriminator and the event's normalized fields plus the
// platform `raw` payload — the same shape reactions and empty messages use — so
// a consumer reads them off the one `messages` stream and narrows via
// `chatHostEvent(message)` (index.ts) instead of these events being dropped.
//
// The who/where/when ride the record's `sender`/`space`/`timestamp` (exactly as
// messages and reactions do); the `custom` payload carries only the event-shaped
// remainder.

import { asCustom } from "@spectrum-ts/core/authoring";
import type {
  ChatActionEvent,
  ChatAdapter,
  ChatAppHomeOpenedEvent,
  ChatAssistantEvent,
  ChatInboundMessage,
  ChatMemberJoinedChannelEvent,
  ChatModalCloseEvent,
  ChatModalSubmitEvent,
  ChatOptionsLoadEvent,
  ChatSlashCommandEvent,
} from "../types";
import { spaceRef } from "./space";

/**
 * The `custom.raw` payloads surfaced for each host event. Discriminated on
 * `chatsdk_type`; the invoking user and conversation ride the record's
 * `sender`/`space` (read them there, not here). Returned typed by
 * `chatHostEvent` so consumers narrow without casting.
 */
export type ChatHostEventPayload =
  | {
      chatsdk_type: "action";
      actionId: string;
      messageId: string;
      value?: string;
      raw: unknown;
    }
  | {
      chatsdk_type: "slash-command";
      command: string;
      text: string;
      triggerId?: string;
      raw: unknown;
    }
  | {
      chatsdk_type: "modal-submit";
      callbackId: string;
      viewId: string;
      values: Record<string, string>;
      privateMetadata?: string;
      raw: unknown;
    }
  | {
      chatsdk_type: "modal-close";
      callbackId: string;
      viewId: string;
      privateMetadata?: string;
      raw: unknown;
    }
  | {
      chatsdk_type: "options-load";
      actionId: string;
      query: string;
      raw: unknown;
    }
  | { chatsdk_type: "app-home-opened" }
  | {
      chatsdk_type: "assistant-thread-started";
      context?: Record<string, unknown>;
    }
  | {
      chatsdk_type: "assistant-context-changed";
      context?: Record<string, unknown>;
    }
  | { chatsdk_type: "member-joined-channel"; inviterId?: string };

/** The set of `chatsdk_type` discriminators a host-event record can carry. */
export const HOST_EVENT_TYPES: ReadonlySet<
  ChatHostEventPayload["chatsdk_type"]
> = new Set([
  "action",
  "slash-command",
  "modal-submit",
  "modal-close",
  "options-load",
  "app-home-opened",
  "assistant-thread-started",
  "assistant-context-changed",
  "member-joined-channel",
]);

// Stamp the shared who/where/when onto a custom host-event payload. `spaceId` is
// the conversation key (a thread id, channel id, or — for modals, which carry no
// conversation — the view id); `id` is the record id.
const record = (
  adapter: ChatAdapter,
  spaceId: string,
  id: string,
  userId: string,
  payload: ChatHostEventPayload
): ChatInboundMessage => ({
  id,
  content: asCustom(payload),
  sender: { id: userId },
  space: spaceRef(adapter, spaceId),
  timestamp: new Date(),
});

export const actionToRecord = (
  adapter: ChatAdapter,
  event: ChatActionEvent
): ChatInboundMessage =>
  record(
    adapter,
    event.threadId,
    `action:${event.messageId}:${event.actionId}`,
    event.user.userId,
    {
      chatsdk_type: "action",
      actionId: event.actionId,
      messageId: event.messageId,
      value: event.value,
      raw: event.raw,
    }
  );

export const slashCommandToRecord = (
  adapter: ChatAdapter,
  event: ChatSlashCommandEvent
): ChatInboundMessage =>
  record(
    adapter,
    event.channelId,
    `slash:${event.channelId}:${event.command}`,
    event.user.userId,
    {
      chatsdk_type: "slash-command",
      command: event.command,
      text: event.text,
      triggerId: event.triggerId,
      raw: event.raw,
    }
  );

export const modalSubmitToRecord = (
  adapter: ChatAdapter,
  event: ChatModalSubmitEvent
): ChatInboundMessage =>
  record(
    adapter,
    event.viewId,
    `modal-submit:${event.viewId}`,
    event.user.userId,
    {
      chatsdk_type: "modal-submit",
      callbackId: event.callbackId,
      viewId: event.viewId,
      values: event.values,
      privateMetadata: event.privateMetadata,
      raw: event.raw,
    }
  );

export const modalCloseToRecord = (
  adapter: ChatAdapter,
  event: ChatModalCloseEvent
): ChatInboundMessage =>
  record(
    adapter,
    event.viewId,
    `modal-close:${event.viewId}`,
    event.user.userId,
    {
      chatsdk_type: "modal-close",
      callbackId: event.callbackId,
      viewId: event.viewId,
      privateMetadata: event.privateMetadata,
      raw: event.raw,
    }
  );

export const optionsLoadToRecord = (
  adapter: ChatAdapter,
  event: ChatOptionsLoadEvent
): ChatInboundMessage =>
  record(
    adapter,
    event.actionId,
    `options-load:${event.actionId}:${event.query}`,
    event.user.userId,
    {
      chatsdk_type: "options-load",
      actionId: event.actionId,
      query: event.query,
      raw: event.raw,
    }
  );

export const appHomeOpenedToRecord = (
  adapter: ChatAdapter,
  event: ChatAppHomeOpenedEvent
): ChatInboundMessage =>
  record(
    adapter,
    event.channelId,
    `app-home:${event.channelId}:${event.userId}`,
    event.userId,
    { chatsdk_type: "app-home-opened" }
  );

export const assistantToRecord = (
  adapter: ChatAdapter,
  event: ChatAssistantEvent,
  kind: "assistant-thread-started" | "assistant-context-changed"
): ChatInboundMessage =>
  record(adapter, event.threadId, `${kind}:${event.threadId}`, event.userId, {
    chatsdk_type: kind,
    context: event.context,
  });

export const memberJoinedToRecord = (
  adapter: ChatAdapter,
  event: ChatMemberJoinedChannelEvent
): ChatInboundMessage =>
  record(
    adapter,
    event.channelId,
    `member-joined:${event.channelId}:${event.userId}`,
    event.userId,
    { chatsdk_type: "member-joined-channel", inviterId: event.inviterId }
  );
