import { Repeater } from "@repeaterjs/repeater";

export interface ManagedStream<T> extends AsyncIterable<T> {
  close(): Promise<void>;
}

export interface AsyncQueue<T> {
  close(): void;
  iterable: AsyncIterable<T>;
  push(value: T): void;
}

/**
 * Unbounded FIFO queue with `AsyncIterable` consumer. Used by FusorCore to feed
 * the per-platform message stream — events pushed before a consumer attaches
 * are buffered, and a pending `next()` is woken when a value arrives.
 */
export function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = [];
  const resolvers: ((result: IteratorResult<T, undefined>) => void)[] = [];
  let closed = false;

  const push = (value: T): void => {
    if (closed) {
      return;
    }
    const resolver = resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      buffer.push(value);
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    while (resolvers.length > 0) {
      const resolver = resolvers.shift();
      resolver?.({ value: undefined, done: true });
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as T;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            resolvers.push(resolve);
          });
        },
        return(): Promise<IteratorResult<T, undefined>> {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return { iterable, push, close };
}

type StreamCleanup = void | (() => void | Promise<void>);

const ignoreCleanupError = () => undefined;

export function stream<T>(
  setup: (
    emit: (value: T) => Promise<void>,
    end: (error?: unknown) => void
  ) => StreamCleanup | Promise<StreamCleanup>
): ManagedStream<T> {
  const repeater = new Repeater<T>(async (push, stop) => {
    const emit = async (value: T): Promise<void> => {
      try {
        await push(value);
      } catch (error) {
        stop(error);
        throw error;
      }
    };
    const end = (error?: unknown) => {
      stop(error);
    };
    const cleanup = await setup(emit, end);

    try {
      await stop;
    } finally {
      await cleanup?.();
    }
  });

  return Object.assign(repeater, {
    close: async () => {
      await repeater.return(undefined).catch(ignoreCleanupError);
    },
  });
}

export function mergeStreams<T>(
  streams: readonly ManagedStream<T>[]
): ManagedStream<T> {
  return stream<T>((emit, end) => {
    if (streams.length === 0) {
      end();
      return;
    }

    let openStreams = streams.length;
    const workers = streams.map(async (source) => {
      try {
        for await (const value of source) {
          await emit(value);
        }
      } catch (error) {
        end(error);
      } finally {
        openStreams -= 1;
        if (openStreams === 0) {
          end();
        }
      }
    });

    return async () => {
      await Promise.allSettled(streams.map((source) => source.close()));
      await Promise.allSettled(workers).catch(ignoreCleanupError);
    };
  });
}

export interface Broadcaster<T> {
  close(): Promise<void>;
  subscribe(): ManagedStream<T>;
}

interface BroadcastConsumer<T> {
  // Chain each delivery off the previous one so a slow consumer's pending
  // emit doesn't block the broadcast pump or other consumers.
  deliveries: Promise<void>;
  emit: (value: T) => Promise<void>;
  end: (error?: unknown) => void;
}

export function broadcast<T>(source: ManagedStream<T>): Broadcaster<T> {
  const consumers = new Set<BroadcastConsumer<T>>();
  let pumping = false;
  let terminated = false;
  let terminalError: unknown;
  let pumpPromise: Promise<void> | undefined;
  let closed = false;

  // End + drop every current consumer. Snapshot first so a consumer's cleanup
  // mutating the set mid-iteration can't skip anyone. Idempotent: a second call
  // after the set is cleared is a no-op.
  const closeConsumers = (error?: unknown) => {
    if (consumers.size === 0) {
      return;
    }
    const current = Array.from(consumers);
    consumers.clear();
    for (const consumer of current) {
      consumer.end(error);
    }
  };

  const startPump = () => {
    if (pumping || terminated) {
      return;
    }
    pumping = true;
    pumpPromise = (async () => {
      try {
        for await (const value of source) {
          // close() may have terminated us mid-stream; stop fanning out.
          if (terminated) {
            break;
          }
          for (const consumer of Array.from(consumers)) {
            consumer.deliveries = consumer.deliveries.then(() =>
              consumer.emit(value).catch(() => {
                // consumer closed mid-emit; cleanup removes it from the set
              })
            );
          }
        }
        if (terminated) {
          // close() already ended consumers; don't wait on stalled deliveries.
          return;
        }
        terminated = true;
        // Natural EOF: wait for in-flight deliveries to drain before ending each
        // consumer so values queued just before EOF still reach them.
        await Promise.allSettled(
          Array.from(consumers, (consumer) => consumer.deliveries)
        );
        closeConsumers();
      } catch (error) {
        terminated = true;
        terminalError = error;
        closeConsumers(error);
      }
    })();
  };

  return {
    subscribe(): ManagedStream<T> {
      return stream<T>((emit, end) => {
        if (terminated || closed) {
          end(terminalError);
          return;
        }
        const consumer: BroadcastConsumer<T> = {
          emit,
          end,
          deliveries: Promise.resolve(),
        };
        consumers.add(consumer);
        startPump();
        return () => {
          consumers.delete(consumer);
        };
      });
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      // End consumers immediately — a stalled subscriber's in-flight delivery
      // must not keep shutdown pending. `terminated` is then the single source
      // of truth that stops the pump and prevents double-ending.
      terminated = true;
      closeConsumers();
      await source.close().catch(ignoreCleanupError);
      if (pumpPromise) {
        await pumpPromise.catch(ignoreCleanupError);
      }
    },
  };
}
