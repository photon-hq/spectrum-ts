import { type ManagedStream, stream } from "./stream";

export const CATCH_UP_PAGE_SIZE = 100;
export const MAX_BUFFERED_LIVE_EVENTS = 1000;
export const RECONNECT_INITIAL_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 30_000;

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
  isRetryableError: (error: unknown) => boolean;
  maxRetryDelayMs?: number;
  processLive: (event: TLive) => Promise<ResumableStreamItem<TOutput>>;
  processMissed: (event: TMissed) => Promise<ResumableStreamItem<TOutput>>;
  subscribeLive: () => CloseableAsyncIterable<TLive>;
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

const closeIterable = async <T>(
  iterable: CloseableAsyncIterable<T> | undefined
): Promise<void> => {
  if (!iterable) {
    return;
  }
  await iterable.close?.();
};

const jitterDelay = (delayMs: number): number => Math.random() * delayMs;

export const resumableOrderedStream = <TLive, TMissed, TOutput>(
  options: ResumableOrderedStreamOptions<TLive, TMissed, TOutput>
): ManagedStream<TOutput> =>
  stream<TOutput>((emit, end) => {
    const catchUpPageSize = options.catchUpPageSize ?? CATCH_UP_PAGE_SIZE;
    const bufferLimit = options.bufferLimit ?? MAX_BUFFERED_LIVE_EVENTS;
    const initialRetryDelayMs =
      options.initialRetryDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? RECONNECT_MAX_DELAY_MS;

    let activeLive: CloseableAsyncIterable<TLive> | undefined;
    let closed = false;
    let lastCursor: string | undefined;
    let retryDelayMs = initialRetryDelayMs;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeSleep: (() => void) | undefined;
    const deliveredSinceCursor = new Set<string>();

    const resetRetryDelay = () => {
      retryDelayMs = initialRetryDelayMs;
    };

    const advanceCursor = (
      cursor: string | undefined,
      clearDelivered: boolean
    ) => {
      if (!cursor || cursor === lastCursor) {
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
        resetRetryDelay();
      }
    };

    const retryable = (error: unknown): boolean =>
      error instanceof RetryableStreamError || options.isRetryableError(error);

    const sleep = async (delayMs: number): Promise<void> => {
      if (delayMs <= 0 || closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wakeSleep = resolve;
        sleepTimer = setTimeout(resolve, jitterDelay(delayMs));
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

    const consumeLive = async (): Promise<void> => {
      const live = options.subscribeLive();
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
      for await (const event of options.fetchMissed(cursor, {
        limit: catchUpPageSize,
      })) {
        throwLiveError(getLiveError());
        await deliverItem(await options.processMissed(event), false, false);
      }
      throwLiveError(getLiveError());
    };

    const flushLiveBuffer = async (
      liveBuffer: TLive[],
      getLiveError: () => unknown
    ): Promise<string | undefined> => {
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
      return lastFlushedId;
    };

    const compactDeliveredIds = (lastId: string | undefined) => {
      if (!lastId) {
        return;
      }
      deliveredSinceCursor.clear();
      deliveredSinceCursor.add(lastId);
    };

    const catchUpThenConsumeLive = async (cursor: string): Promise<void> => {
      const live = options.subscribeLive();
      activeLive = live;

      let buffering = true;
      const liveBuffer: TLive[] = [];
      const livePump = startLivePump(live, () => buffering, liveBuffer);

      try {
        await replayMissed(cursor, livePump.getError);
        const lastFlushedId = await flushLiveBuffer(
          liveBuffer,
          livePump.getError
        );
        compactDeliveredIds(lastFlushedId);
        buffering = false;
        resetRetryDelay();

        await livePump.pump;
        throwLiveError(livePump.getError());
      } finally {
        buffering = false;
        if (activeLive === live) {
          activeLive = undefined;
        }
        await closeIterable(live);
        await livePump.pump.catch(() => undefined);
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
          await closeIterable(activeLive);
          activeLive = undefined;
          if (closed) {
            break;
          }
          if (!retryable(error)) {
            end(error);
            return;
          }
          await sleep(nextRetryDelay());
        }
      }
      end();
    };

    const pump = run().catch((error) => {
      if (!closed) {
        end(error);
      }
    });

    return async () => {
      closed = true;
      cancelSleep();
      await closeIterable(activeLive);
      await pump;
    };
  });
