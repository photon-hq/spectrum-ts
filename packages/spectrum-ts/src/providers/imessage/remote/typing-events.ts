import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "../../../utils/resumable-stream";
import {
  type ManagedStream,
  mergeStreams,
  stream,
} from "../../../utils/stream";

/**
 * Inbound `typing` event record. Matches the generic `[Space, payload]`
 * protocol — `space.id` carries the chat guid; the rest is the indicator
 * status. `displayName` is the typing participant's name (undefined when
 * the SDK can't resolve it). The bot's own typing is not filtered: the
 * SDK doesn't surface an `isFromMe` flag here, so consumers who need to
 * distinguish should check `displayName`.
 *
 * Two cloud clients in the same chat will each emit their own copy of a
 * single typing event — same caveat as the poll stream.
 */
export interface IMessageTypingRecord {
  displayName?: string;
  isTyping: boolean;
  space: { id: string };
  timestamp: Date;
}

const typingRetryJitter = (delayMs: number): number => Math.random() * delayMs;

const logTypingStreamError = (error: unknown) => {
  // Typing events have no cursor — failures are logged and the stream
  // reconnects with backoff. Don't propagate: a transient typing-stream
  // error must not kill peer message/poll streams.
  console.error("[spectrum-ts][imessage][typing] stream failed", error);
};

const runTypingSubscription = async (
  subscription: ReturnType<AdvancedIMessage["chats"]["subscribe"]>,
  emit: (record: IMessageTypingRecord) => Promise<void>,
  onEvent: () => void
): Promise<void> => {
  for await (const event of subscription) {
    if (event.type !== "chat.typingIndicator") {
      continue;
    }
    onEvent();
    await emit({
      space: { id: event.chatGuid as string },
      isTyping: event.isTyping,
      displayName: event.displayName,
      timestamp: event.timestamp,
    });
  }
};

const clientTypingStream = (
  client: AdvancedIMessage
): ManagedStream<IMessageTypingRecord> =>
  stream<IMessageTypingRecord>((emit, end) => {
    let active = client.chats.subscribe();
    let closed = false;
    let retryDelayMs = RECONNECT_INITIAL_DELAY_MS;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeSleep: (() => void) | undefined;

    const sleep = async (delayMs: number): Promise<void> => {
      if (closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wakeSleep = resolve;
        sleepTimer = setTimeout(resolve, typingRetryJitter(delayMs));
      });
      sleepTimer = undefined;
      wakeSleep = undefined;
    };

    const cancelSleep = () => {
      if (sleepTimer) {
        clearTimeout(sleepTimer);
        sleepTimer = undefined;
      }
      wakeSleep?.();
      wakeSleep = undefined;
    };

    const pump = (async () => {
      while (!closed) {
        try {
          await runTypingSubscription(active, emit, () => {
            retryDelayMs = RECONNECT_INITIAL_DELAY_MS;
          });
        } catch (e) {
          if (!closed) {
            logTypingStreamError(e);
          }
        } finally {
          await active.close();
        }

        if (!closed) {
          await sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, RECONNECT_MAX_DELAY_MS);
          active = client.chats.subscribe();
        }
      }
      end();
    })();

    return async () => {
      closed = true;
      cancelSleep();
      await active.close();
      await pump;
    };
  });

export const subscribeTyping = (
  clients: AdvancedIMessage[]
): ManagedStream<IMessageTypingRecord> =>
  mergeStreams(clients.map(clientTypingStream));
