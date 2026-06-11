import { createLogger } from "@photon-ai/otel";
import { type ManagedStream, stream } from "./stream";

export const CATCH_UP_PAGE_SIZE = 100;
export const MAX_BUFFERED_LIVE_EVENTS = 1000;
export const RECONNECT_INITIAL_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 30_000;
// After this many consecutive failures the reconnect log escalates from warn
// to error so persistent causes (credential mismatch, dead proxy, DNS) surface
// in telemetry while the stream keeps retrying.
export const PERSISTENT_FAILURE_ERROR_THRESHOLD = 5;

const log = createLogger("spectrum.stream");

export interface CloseableAsyncIterable<T> extends AsyncIterable<T> {
  close?: () => Promise<void> | void;
}

export interface ResumableStreamItem<T> {
  cursor?: string;
  id: string;
  values: readonly T[];
}

export interface FetchMissedOptions {
  limit: number;
}

export interface ResumableOrderedStreamOptions<TLive, TMissed, TOutput> {
  bufferLimit?: number;
  catchUpPageSize?: number;
  fetchMissed: (
    cursor: string,
    options: FetchMissedOptions
  ) => AsyncIterable<TMissed>;
  initialRetryDelayMs?: number;
  /**
   * Recognizes a `fetchMissed` failure that means the server rejected the
   * resume cursor (e.g. it was pruned). The stream then drops the cursor,
   * accepts the event gap, and resumes live. Only errors raised by the
   * `fetchMissed` iteration itself are classified.
   */
  isCursorRejectedError?: (error: unknown) => boolean;
  /** Maps a nominal retry delay to the actual sleep; injectable for tests. */
  jitter?: (delayMs: number) => number;
  /** Log provenance, e.g. "imessage.messages:+1555…". */
  label?: string;
  maxRetryDelayMs?: number;
  processLive: (event: TLive) => Promise<ResumableStreamItem<TOutput>>;
  processMissed: (event: TMissed) => Promise<ResumableStreamItem<TOutput>>;
  subscribeLive: (cursor?: string) => CloseableAsyncIterable<TLive>;
}

class RetryableStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableStreamError";
  }
}

class LiveBufferOverflowError extends RetryableStreamError {
  constructor(limit: number) {
    super(`Live stream buffer exceeded ${limit} events during catch-up`);
    this.name = "LiveBufferOverflowError";
  }
}

// Sentinel for a server-rejected resume cursor: the only recovery is to drop
// the cursor, accept the event gap, and resume live.
class CursorRejectedError extends Error {
  constructor(cause: unknown) {
    super("Server rejected resume cursor", { cause });
    this.name = "CursorRejectedError";
  }
}

const closeIterable = async <T>(
  iterable: CloseableAsyncIterable<T> | undefined
): Promise<void> => {
  if (!iterable) {
    return;
  }
  await iterable.close?.();
};

const ignoreCleanupError = () => undefined;

// Equal jitter: a near-zero random draw must not defeat backoff during an
// outage, so the floor is half the nominal delay.
const jitterDelay = (delayMs: number): number =>
  delayMs * (0.5 + Math.random() * 0.5);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Classifies only rejections raised by `source` itself: errors thrown by the
// consuming for-await body exit a `yield*` through return(), not this catch,
// so a processMissed/live error can never masquerade as a cursor rejection.
async function* throwOnCursorRejection<T>(
  source: AsyncIterable<T>,
  isCursorRejected: (error: unknown) => boolean
): AsyncGenerator<T> {
  try {
    yield* source;
  } catch (error) {
    throw isCursorRejected(error) ? new CursorRejectedError(error) : error;
  }
}

const numericCursor = (cursor: string | undefined): number | undefined => {
  if (!cursor) {
    return;
  }
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const isCursorRegression = (
  next: string | undefined,
  current: string | undefined
): boolean => {
  const nextValue = numericCursor(next);
  const currentValue = numericCursor(current);
  return (
    nextValue !== undefined &&
    currentValue !== undefined &&
    nextValue < currentValue
  );
};

/**
 * Wraps a live event stream with cursor-based catch-up and reconnects forever
 * with capped, jittered exponential backoff — the stream never ends with an
 * error. The only terminal events are `close()` and consumer disconnect. When
 * the server rejects the resume cursor, the cursor is dropped and consumption
 * falls back to live, accepting (and logging) the event gap.
 */
export const resumableOrderedStream = <TLive, TMissed, TOutput>(
  options: ResumableOrderedStreamOptions<TLive, TMissed, TOutput>
): ManagedStream<TOutput> =>
  stream<TOutput>((emit, end) => {
    const catchUpPageSize = options.catchUpPageSize ?? CATCH_UP_PAGE_SIZE;
    const bufferLimit = options.bufferLimit ?? MAX_BUFFERED_LIVE_EVENTS;
    const initialRetryDelayMs =
      options.initialRetryDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? RECONNECT_MAX_DELAY_MS;
    const jitter = options.jitter ?? jitterDelay;
    const label = options.label;

    let activeLive: CloseableAsyncIterable<TLive> | undefined;
    let closed = false;
    let failedAttempts = 0;
    let lastCursor: string | undefined;
    let retryDelayMs = initialRetryDelayMs;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeSleep: (() => void) | undefined;
    const deliveredSinceCursor = new Set<string>();

    const noteRecovery = () => {
      retryDelayMs = initialRetryDelayMs;
      if (failedAttempts === 0) {
        return;
      }
      log.info("stream recovered", { attempts: failedAttempts, label });
      failedAttempts = 0;
    };

    const advanceCursor = (
      cursor: string | undefined,
      clearDelivered: boolean
    ) => {
      if (
        !cursor ||
        cursor === lastCursor ||
        isCursorRegression(cursor, lastCursor)
      ) {
        return;
      }
      lastCursor = cursor;
      if (clearDelivered) {
        deliveredSinceCursor.clear();
      }
    };

    const deliverItem = async (
      item: ResumableStreamItem<TOutput>,
      resetRetry: boolean,
      clearOnCursorAdvance: boolean
    ) => {
      const alreadyDelivered = deliveredSinceCursor.has(item.id);
      if (!alreadyDelivered) {
        for (const value of item.values) {
          await emit(value);
        }
      }
      advanceCursor(item.cursor, clearOnCursorAdvance);
      deliveredSinceCursor.add(item.id);
      if (resetRetry) {
        noteRecovery();
      }
    };

    const isCursorRejected = (error: unknown): boolean =>
      options.isCursorRejectedError?.(error) === true;

    const sleep = async (delayMs: number): Promise<void> => {
      if (delayMs <= 0 || closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wakeSleep = resolve;
        sleepTimer = setTimeout(resolve, jitter(delayMs));
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

    const nextRetryDelay = (): number => {
      const delay = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
      return delay;
    };

    const handleFailure = (error: unknown): number => {
      failedAttempts += 1;
      const delayMs = nextRetryDelay();
      if (error instanceof CursorRejectedError) {
        lastCursor = undefined;
        deliveredSinceCursor.clear();
        log.warn(
          "resume cursor rejected; accepting event gap and resuming live",
          {
            attempt: failedAttempts,
            delayMs,
            error: errorMessage(error.cause),
            label,
          }
        );
        return delayMs;
      }
      const attrs = {
        attempt: failedAttempts,
        delayMs,
        error: errorMessage(error),
        hasCursor: lastCursor !== undefined,
        label,
      };
      if (failedAttempts >= PERSISTENT_FAILURE_ERROR_THRESHOLD) {
        log.error("stream persistently failing; still retrying", attrs, error);
        return delayMs;
      }
      log.warn("stream interrupted; reconnecting", attrs);
      return delayMs;
    };

    const consumeLive = async (): Promise<void> => {
      const live = options.subscribeLive(lastCursor);
      activeLive = live;
      try {
        for await (const event of live) {
          await deliverItem(await options.processLive(event), true, true);
        }
        throw new RetryableStreamError("Live stream ended");
      } finally {
        if (activeLive === live) {
          activeLive = undefined;
        }
        await closeIterable(live);
      }
    };

    const throwLiveError = (liveError: unknown) => {
      if (liveError) {
        throw liveError;
      }
    };

    const bufferLiveEvent = (buffer: TLive[], event: TLive) => {
      if (buffer.length >= bufferLimit) {
        throw new LiveBufferOverflowError(bufferLimit);
      }
      buffer.push(event);
    };

    const startLivePump = (
      live: CloseableAsyncIterable<TLive>,
      isBuffering: () => boolean,
      liveBuffer: TLive[]
    ) => {
      let liveError: unknown;
      const pump = (async () => {
        try {
          for await (const event of live) {
            if (isBuffering()) {
              bufferLiveEvent(liveBuffer, event);
              continue;
            }
            await deliverItem(await options.processLive(event), true, true);
          }
          throw new RetryableStreamError("Live stream ended");
        } catch (error) {
          liveError = error;
        }
      })();
      return {
        getError: () => liveError,
        pump,
      };
    };

    const replayMissed = async (
      cursor: string,
      getLiveError: () => unknown
    ) => {
      const missed = throwOnCursorRejection(
        options.fetchMissed(cursor, { limit: catchUpPageSize }),
        isCursorRejected
      );
      for await (const event of missed) {
        throwLiveError(getLiveError());
        await deliverItem(await options.processMissed(event), false, false);
      }
      throwLiveError(getLiveError());
    };

    const flushLiveBuffer = async (
      liveBuffer: TLive[],
      getLiveError: () => unknown,
      stopBuffering: () => void
    ): Promise<void> => {
      let index = 0;
      let lastFlushedId: string | undefined;
      // The live pump keeps appending while buffering remains true, and JS
      // async work runs on one thread, so this loop intentionally observes
      // newly buffered events before switching back to direct live delivery.
      while (index < liveBuffer.length) {
        throwLiveError(getLiveError());
        const event = liveBuffer[index];
        if (event === undefined) {
          throw new RetryableStreamError("Live stream buffer index missing");
        }
        const item = await options.processLive(event);
        await deliverItem(item, true, false);
        lastFlushedId = item.id;
        index += 1;
      }
      liveBuffer.length = 0;
      throwLiveError(getLiveError());
      // Compact and stop buffering synchronously with the final emptiness
      // check above — an await in between would let the pump buffer an event
      // that nothing ever flushes (stranded and silently dropped).
      compactDeliveredIds(lastFlushedId);
      stopBuffering();
    };

    const compactDeliveredIds = (lastId: string | undefined) => {
      if (!lastId) {
        return;
      }
      deliveredSinceCursor.clear();
      deliveredSinceCursor.add(lastId);
    };

    const catchUpThenConsumeLive = async (cursor: string): Promise<void> => {
      const live = options.subscribeLive(cursor);
      activeLive = live;

      let buffering = true;
      const liveBuffer: TLive[] = [];
      const livePump = startLivePump(live, () => buffering, liveBuffer);

      try {
        await replayMissed(cursor, livePump.getError);
        await flushLiveBuffer(liveBuffer, livePump.getError, () => {
          buffering = false;
        });
        noteRecovery();

        await livePump.pump;
        throwLiveError(livePump.getError());
      } finally {
        buffering = false;
        if (activeLive === live) {
          activeLive = undefined;
        }
        await closeIterable(live);
        await livePump.pump.catch(ignoreCleanupError);
      }
    };

    const run = async () => {
      while (!closed) {
        try {
          if (lastCursor) {
            await catchUpThenConsumeLive(lastCursor);
          } else {
            await consumeLive();
          }
        } catch (error) {
          await closeIterable(activeLive).catch(ignoreCleanupError);
          activeLive = undefined;
          if (closed) {
            break;
          }
          await sleep(handleFailure(error));
        }
      }
      end();
    };

    // Defensive invariant: run() retries everything internally, so this catch
    // should be unreachable — if it ever fires, fail loudly instead of dying
    // in silence.
    const pump = run().catch((error) => {
      log.error("resumable stream loop crashed", { label }, error);
      if (!closed) {
        end(error);
      }
    });

    return async () => {
      closed = true;
      cancelSleep();
      await closeIterable(activeLive);
      await pump.catch(ignoreCleanupError);
    };
  });
