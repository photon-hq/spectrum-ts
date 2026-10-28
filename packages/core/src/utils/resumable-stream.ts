import { createLogger, type LogAttrs } from "@photon-ai/otel";
import { type ManagedStream, stream } from "./stream";
import { errorAttrs } from "./telemetry";

export const CATCH_UP_PAGE_SIZE = 100;
export const MAX_BUFFERED_LIVE_EVENTS = 1000;
export const RECONNECT_INITIAL_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const PENDING_OPERATION_WARNING_MS = 30_000;
// After this many consecutive failures the reconnect log escalates from warn
// to error so persistent causes (credential mismatch, dead proxy, DNS) surface
// in telemetry while the stream keeps retrying.
export const PERSISTENT_FAILURE_ERROR_THRESHOLD = 5;
// A live subscription that stays up this long counts as recovered even before
// an event arrives, so idle streams do not accumulate failures forever.
export const LIVE_HEALTHY_AFTER_MS = 20_000;

const log = createLogger("spectrum.stream");

type StreamPhase = "catch-up" | "live";

export interface CloseableAsyncIterable<T> extends AsyncIterable<T> {
  close?: () => Promise<void> | void;
  /** Enables pending-operation diagnostics. Identity only; never payloads or secrets. */
  readonly diagnosticAttrs?: Readonly<LogAttrs>;
}

/** Passed to `subscribeLive`; `alive()` reports a server liveness signal such as a heartbeat. */
export interface LiveSignals {
  alive: () => void;
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
  /** Raw event provenance before mapping; exclude payloads, phones, and secrets. */
  eventDiagnosticAttrs?: (event: TLive | TMissed) => LogAttrs;
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
  /** Uptime after which a live `alive()` signal resets the failure count; injectable for tests. */
  liveHealthyAfterMs?: number;
  maxRetryDelayMs?: number;
  processLive: (event: TLive) => Promise<ResumableStreamItem<TOutput>>;
  processMissed: (event: TMissed) => Promise<ResumableStreamItem<TOutput>>;
  /**
   * Invoked when reconnects have failed persistently (the consecutive-failure
   * count has reached a multiple of `PERSISTENT_FAILURE_ERROR_THRESHOLD`) to
   * rebuild state a plain reconnect cannot refresh — e.g. re-mint an auth token
   * the server rejects after a restart. Runs between the failure and the next
   * retry, throttled to once per threshold window, and resets once the stream
   * recovers. Errors thrown are logged and swallowed; the reconnect loop
   * continues either way, so a recover that itself fails is harmless.
   */
  recover?: (error: unknown, failureCount: number) => Promise<void> | void;
  /** Cap on how long a `recover` hook may run before it is abandoned; injectable for tests. */
  recoverTimeoutMs?: number;
  /** Return false for failures `recover` cannot fix; they skip the hook without spending its window. */
  shouldRecover?: (error: unknown) => boolean;
  subscribeLive: (
    cursor: string | undefined,
    signals: LiveSignals
  ) => CloseableAsyncIterable<TLive>;
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

// A recover hook (e.g. an auth-token re-mint) that never settles must not
// freeze the reconnect loop or leave close() waiting on the pump forever. Cap
// it; on timeout the abandoned result is ignored and the loop proceeds.
const RECOVER_TIMEOUT_MS = 30_000;

const runWithTimeout = async (
  work: Promise<void>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<void> => {
  // Swallow a late rejection from the abandoned work so it can't surface as an
  // unhandled rejection once we stop awaiting it.
  work.catch(ignoreCleanupError);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

// Equal jitter: a near-zero random draw must not defeat backoff during an
// outage, so the floor is half the nominal delay.
const jitterDelay = (delayMs: number): number =>
  delayMs * (0.5 + Math.random() * 0.5);

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
    const recoverTimeoutMs = options.recoverTimeoutMs ?? RECOVER_TIMEOUT_MS;
    const liveHealthyAfterMs =
      options.liveHealthyAfterMs ?? LIVE_HEALTHY_AFTER_MS;
    const label = options.label;

    let activeLive: CloseableAsyncIterable<TLive> | undefined;
    let closed = false;
    let failedAttempts = 0;
    // The `failedAttempts` value at which `recover` last ran, so the hook fires
    // at most once per `PERSISTENT_FAILURE_ERROR_THRESHOLD` window instead of on
    // every retry. Reset on recovery so a later outage triggers it again.
    let lastRecoverAttempt = 0;
    let liveGeneration = 0;
    let lastCursor: string | undefined;
    let retryDelayMs = initialRetryDelayMs;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeSleep: (() => void) | undefined;
    const deliveredSinceCursor = new Set<string>();
    // Stable id so concurrent streams (and one stream's reconnect storm) are
    // distinguishable in logs and traces.
    const streamId =
      globalThis.crypto?.randomUUID?.() ??
      `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    const baseStreamAttrs = (phase: StreamPhase): LogAttrs => ({
      "spectrum.stream.id": streamId,
      "spectrum.stream.label": label,
      "spectrum.stream.phase": phase,
      "spectrum.stream.has_cursor": lastCursor !== undefined,
      "spectrum.stream.cursor": lastCursor,
    });

    const noteRecovery = () => {
      retryDelayMs = initialRetryDelayMs;
      lastRecoverAttempt = 0;
      if (failedAttempts === 0) {
        return;
      }
      log.info("stream recovered", {
        "spectrum.stream.id": streamId,
        "spectrum.stream.label": label,
        "spectrum.stream.attempt": failedAttempts,
      });
      failedAttempts = 0;
    };

    // Only the newest subscription may report liveness, and only once it has
    // outlived a connect-then-drop flap. With a cursor, finishing catch-up is
    // the recovery signal instead.
    const liveSignals = (phase: StreamPhase): LiveSignals => {
      liveGeneration += 1;
      const generation = liveGeneration;
      const openedAt = Date.now();
      return {
        alive: () => {
          if (
            phase === "live" &&
            !closed &&
            generation === liveGeneration &&
            Date.now() - openedAt >= liveHealthyAfterMs
          ) {
            noteRecovery();
          }
        },
      };
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

    const diagnosticAttrs = (
      live: CloseableAsyncIterable<TLive>,
      event: TLive | TMissed,
      origin: "live" | "catch-up" | "buffered-live"
    ): LogAttrs | undefined => {
      if (!live.diagnosticAttrs) {
        return;
      }
      let eventAttrs: LogAttrs | undefined;
      try {
        eventAttrs = options.eventDiagnosticAttrs?.(event);
      } catch {
        // Missing diagnostic metadata must not change event delivery.
      }
      return {
        ...eventAttrs,
        ...live.diagnosticAttrs,
        "spectrum.stream.id": streamId,
        "spectrum.stream.origin": origin,
        "spectrum.stream.subscription_role":
          origin === "catch-up" ? "concurrent-live" : "source",
        "spectrum.stream.cursor": lastCursor,
      };
    };

    const observePending = async <TResult>(
      operation: "mapping" | "emit",
      attrs: LogAttrs | undefined,
      work: () => Promise<TResult>
    ): Promise<TResult> => {
      if (!attrs || closed) {
        return work();
      }
      const startedAt = performance.now();
      let warned = false;
      let outcome = "failed";
      const operationAttrs = () => ({
        ...attrs,
        "spectrum.stream.operation": operation,
        "spectrum.stream.pending_ms": Math.round(performance.now() - startedAt),
      });
      const timer = setTimeout(() => {
        if (closed) {
          return;
        }
        warned = true;
        try {
          log.warn("stream operation still pending", operationAttrs());
        } catch {
          // Diagnostics must not interrupt the stream.
        }
      }, PENDING_OPERATION_WARNING_MS);
      timer.unref?.();
      pendingTimer = timer;
      try {
        const result = await work();
        outcome = "completed";
        return result;
      } finally {
        clearTimeout(timer);
        pendingTimer = undefined;
        if (warned && !closed) {
          try {
            log.info("previously pending stream operation settled", {
              ...operationAttrs(),
              "spectrum.stream.outcome": outcome,
            });
          } catch {
            // Preserve the original operation outcome.
          }
        }
      }
    };

    const processItem = async (
      map: () => Promise<ResumableStreamItem<TOutput>>,
      resetRetry: boolean,
      clearOnCursorAdvance: boolean,
      attrs: LogAttrs | undefined
    ) => {
      const item = await observePending("mapping", attrs, map);
      const alreadyDelivered = deliveredSinceCursor.has(item.id);
      if (!alreadyDelivered) {
        for (const value of item.values) {
          await observePending("emit", attrs, () => emit(value));
        }
      }
      advanceCursor(item.cursor, clearOnCursorAdvance);
      deliveredSinceCursor.add(item.id);
      if (resetRetry) {
        noteRecovery();
      }
      return item;
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

    const failureKind = (error: unknown): string => {
      if (error instanceof CursorRejectedError) {
        return "cursor-rejected";
      }
      if (failedAttempts >= PERSISTENT_FAILURE_ERROR_THRESHOLD) {
        return "persistent";
      }
      return "transient";
    };

    const handleFailure = (error: unknown, phase: StreamPhase): number => {
      failedAttempts += 1;
      const delayMs = nextRetryDelay();
      // Capture cursor/phase state before the cursor-rejected branch clears it,
      // so the log shows which cursor was rejected. Unwrap CursorRejectedError
      // to surface the underlying server error in `spectrum.error.*`.
      const attrs: LogAttrs = {
        ...baseStreamAttrs(phase),
        "spectrum.stream.attempt": failedAttempts,
        "spectrum.stream.delay_ms": delayMs,
        "spectrum.stream.failure_kind": failureKind(error),
        ...errorAttrs(
          error instanceof CursorRejectedError ? error.cause : error
        ),
      };
      if (error instanceof CursorRejectedError) {
        lastCursor = undefined;
        deliveredSinceCursor.clear();
        log.warn(
          "resume cursor rejected; accepting event gap and resuming live",
          attrs,
          error
        );
        return delayMs;
      }
      if (failedAttempts >= PERSISTENT_FAILURE_ERROR_THRESHOLD) {
        log.error("stream persistently failing; still retrying", attrs, error);
        return delayMs;
      }
      log.warn("stream interrupted; reconnecting", attrs, error);
      return delayMs;
    };

    // Once reconnects fail persistently, give the caller a chance to rebuild
    // state a plain retry cannot fix (e.g. re-mint a rejected auth token).
    // Throttled to once per threshold window via `lastRecoverAttempt`; a hook
    // that throws is logged and ignored so it can never wedge the loop.
    const maybeRecover = async (error: unknown): Promise<void> => {
      if (
        !options.recover ||
        options.shouldRecover?.(error) === false ||
        failedAttempts < PERSISTENT_FAILURE_ERROR_THRESHOLD ||
        failedAttempts - lastRecoverAttempt < PERSISTENT_FAILURE_ERROR_THRESHOLD
      ) {
        return;
      }
      lastRecoverAttempt = failedAttempts;
      try {
        await runWithTimeout(
          Promise.resolve(options.recover(error, failedAttempts)),
          recoverTimeoutMs,
          () =>
            new Error(
              `recover hook did not settle within ${recoverTimeoutMs}ms`
            )
        );
        log.info("stream recover hook ran", {
          "spectrum.stream.id": streamId,
          "spectrum.stream.label": label,
          "spectrum.stream.attempt": failedAttempts,
        });
      } catch (recoverError) {
        log.warn(
          "stream recover hook failed",
          {
            "spectrum.stream.id": streamId,
            "spectrum.stream.label": label,
            "spectrum.stream.attempt": failedAttempts,
            ...errorAttrs(recoverError),
          },
          recoverError
        );
      }
    };

    const consumeLive = async (): Promise<void> => {
      const live = options.subscribeLive(lastCursor, liveSignals("live"));
      activeLive = live;
      try {
        for await (const event of live) {
          await processItem(
            () => options.processLive(event),
            true,
            true,
            diagnosticAttrs(live, event, "live")
          );
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
            await processItem(
              () => options.processLive(event),
              true,
              true,
              diagnosticAttrs(live, event, "live")
            );
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
      getLiveError: () => unknown,
      live: CloseableAsyncIterable<TLive>
    ) => {
      const missed = throwOnCursorRejection(
        options.fetchMissed(cursor, { limit: catchUpPageSize }),
        isCursorRejected
      );
      for await (const event of missed) {
        throwLiveError(getLiveError());
        await processItem(
          () => options.processMissed(event),
          false,
          false,
          diagnosticAttrs(live, event, "catch-up")
        );
      }
      throwLiveError(getLiveError());
    };

    const flushLiveBuffer = async (
      liveBuffer: TLive[],
      getLiveError: () => unknown,
      stopBuffering: () => void,
      live: CloseableAsyncIterable<TLive>
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
        const item = await processItem(
          () => options.processLive(event),
          true,
          false,
          diagnosticAttrs(live, event, "buffered-live")
        );
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
      const live = options.subscribeLive(cursor, liveSignals("catch-up"));
      activeLive = live;

      let buffering = true;
      const liveBuffer: TLive[] = [];
      const livePump = startLivePump(live, () => buffering, liveBuffer);

      try {
        await replayMissed(cursor, livePump.getError, live);
        await flushLiveBuffer(
          liveBuffer,
          livePump.getError,
          () => {
            buffering = false;
          },
          live
        );
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
        const phase: StreamPhase = lastCursor ? "catch-up" : "live";
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
          const delayMs = handleFailure(error, phase);
          await maybeRecover(error);
          await sleep(delayMs);
        }
      }
      end();
    };

    // Defensive invariant: run() retries everything internally, so this catch
    // should be unreachable — if it ever fires, fail loudly instead of dying
    // in silence.
    const pump = run().catch((error) => {
      log.error(
        "resumable stream loop crashed",
        { "spectrum.stream.id": streamId, "spectrum.stream.label": label },
        error
      );
      if (!closed) {
        end(error);
      }
    });

    return async () => {
      closed = true;
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
      cancelSleep();
      await closeIterable(activeLive);
      await pump.catch(ignoreCleanupError);
    };
  });
