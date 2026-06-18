// SpectrumChatHost: the provider's own implementation of the chat-SDK host that
// adapters dispatch back into. Where the old provider wrapped a `Chat` instance
// (which played host to a map of adapters), each Spectrum platform now drives a
// SINGLE adapter and IS the host. `adapter.initialize(host)` stores this as
// `this.chat`; the adapter then calls the methods below as events arrive.
//
// Verified against the real Discord, Slack, and Linear adapters: Discord
// dispatches plain messages through the deprecated `handleIncomingMessage` and
// reactions through `processReaction`; Linear uses `processMessage` and reads
// `getState()` for OAuth-installation persistence; Slack drives the full
// interactive surface. Beyond messages + reactions, the interactive and
// lifecycle events chat's `ChatInstance` declares (button actions, slash
// commands, modal submit/close, dynamic-select option loads, app-home opens,
// the Slack assistant surface, channel-membership) are surfaced as `custom`
// inbound records (see inbound/host-event.ts) rather than dropped — so wrapping
// chat-sdk exposes its whole event surface, not just the message path. Only
// `transcripts` stays unmodeled (it throws on access, matching chat-sdk's own
// "not configured" guard).

import type { ChatInstance, Logger, StateAdapter, TranscriptsApi } from "chat";
import {
  actionToRecord,
  appHomeOpenedToRecord,
  assistantToRecord,
  memberJoinedToRecord,
  modalCloseToRecord,
  modalSubmitToRecord,
  optionsLoadToRecord,
  slashCommandToRecord,
} from "./inbound/host-event";
import { reactionToRecord } from "./inbound/reaction";
import { messageToRecords } from "./inbound/records";
import type { EventQueue } from "./queue";
import type { MakeThread } from "./thread";
import type {
  ChatActionEvent,
  ChatAdapter,
  ChatAppHomeOpenedEvent,
  ChatAssistantEvent,
  ChatInboundMessage,
  ChatMemberJoinedChannelEvent,
  ChatMessage,
  ChatModalCloseEvent,
  ChatModalSubmitEvent,
  ChatOptionsLoadEvent,
  ChatReactionEvent,
  ChatSlashCommandEvent,
  ThreadRegistry,
} from "./types";

// How long a processed message id is remembered for duplicate suppression.
// Matches chat-sdk's own `DEDUPE_TTL_MS` (5 min) so a redelivered webhook (e.g.
// Linear retries) inside that window is dropped rather than re-handled.
const DEDUPE_TTL_MS = 5 * 60 * 1000;

// The slice of the chat-SDK state adapter we use for dedupe. Feature-detected at
// runtime — a custom `state` without it simply skips dedupe rather than throwing.
interface DedupeState {
  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
}

const hasDedupe = (state: unknown): state is DedupeState =>
  typeof (state as DedupeState | undefined)?.setIfNotExists === "function";

export interface SpectrumChatHostDeps {
  adapter: ChatAdapter;
  logger: Logger;
  /** Build (and cache) a live thread handle from a thread id. */
  makeThread: MakeThread;
  queue: EventQueue<ChatInboundMessage>;
  /**
   * The chat-SDK state adapter. Resolved EAGERLY in `createClient` (not lazily)
   * because adapters call `getState()` synchronously — e.g. Linear during OAuth.
   * Typed `unknown` internally so a minimal custom `state` (missing
   * `setIfNotExists`/`connect`) still works via the feature-detection below;
   * `getState()` casts to the `StateAdapter` the chat contract expects.
   */
  state: unknown;
  threads: ThreadRegistry;
  /** Resolved bot username (config.userName ?? project slug ?? default). */
  userName: string;
}

export class SpectrumChatHost implements ChatInstance {
  private readonly deps: SpectrumChatHostDeps;

  constructor(deps: SpectrumChatHostDeps) {
    this.deps = deps;
  }

  // --- synchronous accessors the adapter reads -----------------------------
  getState(): StateAdapter {
    return this.deps.state as StateAdapter;
  }

  getUserName(): string {
    return this.deps.userName;
  }

  getLogger(_prefix?: string): Logger {
    return this.deps.logger;
  }

  // chat-sdk's cross-platform transcript store is not configured by this
  // provider; match chat's own "throws on access when unconfigured" contract.
  get transcripts(): TranscriptsApi {
    throw new Error("chatSDK: transcripts are not configured");
  }

  // --- inbound message paths -----------------------------------------------
  // Discord (deprecated handler) — already a resolved message. Async now that
  // ingest awaits dedupe; the adapter `await`s this (the interface permits
  // `Promise<void>`), so errors propagate just as the old synchronous path did.
  handleIncomingMessage(
    adapter: ChatAdapter,
    threadId: string,
    message: ChatMessage
  ): Promise<void> {
    return this.ingest(adapter, threadId, message);
  }

  // Linear (and the modern path) — `message` may be a lazy async factory.
  async processMessage(
    adapter: ChatAdapter,
    threadId: string,
    message: ChatMessage | (() => Promise<ChatMessage>),
    _options?: unknown
  ): Promise<void> {
    const resolved = typeof message === "function" ? await message() : message;
    await this.ingest(adapter, threadId, resolved);
  }

  // --- reactions -----------------------------------------------------------
  processReaction(event: ChatReactionEvent): void {
    // Skip the bot's own reactions — same self-filter the message path applies,
    // for adapters (Linear) that surface self-reactions and leave the skip to
    // the host rather than filtering before dispatch.
    if (event.user.isMe) {
      return;
    }
    const adapter = event.adapter ?? this.deps.adapter;
    this.deps.queue.push(reactionToRecord(adapter, event));
  }

  // --- interactive + lifecycle host surface --------------------------------
  // Each chat-SDK host event is surfaced as a `custom` inbound record on the
  // same `messages` stream (see inbound/host-event.ts), discriminated by
  // `chatsdk_type` and read ergonomically via `chatHostEvent(message)`. The
  // bot's own actions are self-filtered (mirroring messages + reactions) so a
  // reply that triggers an interaction never re-feeds the loop. Events the
  // adapter awaits a response from (`processModalSubmit`, `processOptionsLoad`)
  // resolve to `undefined` — accept the modal / supply no dynamic options —
  // while still surfacing the event for observation.

  processAction(event: ChatActionEvent): Promise<void> {
    this.pushHostEvent(event.user.isMe, event.adapter, (adapter) =>
      actionToRecord(adapter, event)
    );
    return Promise.resolve();
  }

  processSlashCommand(event: ChatSlashCommandEvent): void {
    this.pushHostEvent(event.user.isMe, event.adapter, (adapter) =>
      slashCommandToRecord(adapter, event)
    );
  }

  processModalSubmit(event: ChatModalSubmitEvent): Promise<undefined> {
    this.pushHostEvent(event.user.isMe, event.adapter, (adapter) =>
      modalSubmitToRecord(adapter, event)
    );
    return Promise.resolve(undefined);
  }

  processModalClose(event: ChatModalCloseEvent): void {
    this.pushHostEvent(event.user.isMe, event.adapter, (adapter) =>
      modalCloseToRecord(adapter, event)
    );
  }

  processOptionsLoad(event: ChatOptionsLoadEvent): Promise<undefined> {
    this.pushHostEvent(event.user.isMe, event.adapter, (adapter) =>
      optionsLoadToRecord(adapter, event)
    );
    return Promise.resolve(undefined);
  }

  processAppHomeOpened(event: ChatAppHomeOpenedEvent): void {
    this.pushHostEvent(false, event.adapter, (adapter) =>
      appHomeOpenedToRecord(adapter, event)
    );
  }

  processAssistantThreadStarted(event: ChatAssistantEvent): void {
    this.pushHostEvent(false, event.adapter, (adapter) =>
      assistantToRecord(adapter, event, "assistant-thread-started")
    );
  }

  processAssistantContextChanged(event: ChatAssistantEvent): void {
    this.pushHostEvent(false, event.adapter, (adapter) =>
      assistantToRecord(adapter, event, "assistant-context-changed")
    );
  }

  processMemberJoinedChannel(event: ChatMemberJoinedChannelEvent): void {
    this.pushHostEvent(false, event.adapter, (adapter) =>
      memberJoinedToRecord(adapter, event)
    );
  }

  // Skip the bot's own actions, resolve the adapter (events carry it; fall back
  // to the single bound adapter like reactions do), build the record, and queue
  // it. Shared by every interactive/lifecycle handler above.
  private pushHostEvent(
    isMe: boolean | undefined,
    eventAdapter: ChatAdapter | undefined,
    build: (adapter: ChatAdapter) => ChatInboundMessage
  ): void {
    if (isMe) {
      return;
    }
    this.deps.queue.push(build(eventAdapter ?? this.deps.adapter));
  }

  // Build a thread handle, cache it so outbound replies route through the live
  // (streaming-aware) handle, and fan the message out into Spectrum records —
  // after applying the host's inbound contract (self-filter + dedupe).
  private async ingest(
    adapter: ChatAdapter,
    threadId: string,
    message: ChatMessage
  ): Promise<void> {
    // Drop the bot's own messages so a reply never re-triggers the loop.
    // Discord filters these at the gateway, but Linear delivers self-authored
    // comments over its webhook with `author.isMe` set and leaves the skip to
    // the host — so without this an outbound reply round-trips and the bot
    // answers itself indefinitely.
    if (message.author.isMe) {
      return;
    }

    // Suppress duplicate deliveries (e.g. Linear retries a webhook) by message
    // id, keyed per adapter. Mirrors chat-sdk's own dedupe; skipped silently if
    // the configured state adapter doesn't support `setIfNotExists`.
    if (await this.isDuplicate(adapter, message.id)) {
      return;
    }

    const thread = this.deps.makeThread(threadId, message);
    this.deps.threads.set(threadId, thread);
    for (const record of messageToRecords(adapter, threadId, message, thread)) {
      this.deps.queue.push(record);
    }
  }

  // True when this `(adapter, messageId)` was already processed within the TTL.
  // The first sighting records the id and returns false; a custom state adapter
  // without `setIfNotExists` opts out of dedupe (always false).
  private async isDuplicate(
    adapter: ChatAdapter,
    messageId: string
  ): Promise<boolean> {
    const { state } = this.deps;
    if (!hasDedupe(state)) {
      return false;
    }
    const key = `dedupe:${adapter.name}:${messageId}`;
    const isFirst = await state.setIfNotExists(key, true, DEDUPE_TTL_MS);
    return !isFirst;
  }
}
