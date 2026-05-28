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

  const startPump = () => {
    if (pumping || terminated) {
      return;
    }
    pumping = true;
    pumpPromise = (async () => {
      try {
        for await (const value of source) {
          for (const consumer of consumers) {
            consumer.deliveries = consumer.deliveries.then(() =>
              consumer.emit(value).catch(() => {
                // consumer closed mid-emit; cleanup removes it from the set
              })
            );
          }
        }
        terminated = true;
        // Wait for in-flight deliveries to drain before ending each consumer
        // so values queued just before EOF still reach them.
        await Promise.allSettled(
          Array.from(consumers, (consumer) => consumer.deliveries)
        );
        for (const consumer of consumers) {
          consumer.end();
        }
        consumers.clear();
      } catch (error) {
        terminated = true;
        terminalError = error;
        for (const consumer of consumers) {
          consumer.end(error);
        }
        consumers.clear();
      }
    })();
  };

  return {
    subscribe(): ManagedStream<T> {
      return stream<T>((emit, end) => {
        if (terminated) {
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
      try {
        await source.close();
        if (pumpPromise) {
          await pumpPromise.catch(ignoreCleanupError);
        }
      } finally {
        if (!terminated) {
          terminated = true;
          for (const consumer of consumers) {
            consumer.end();
          }
          consumers.clear();
        }
      }
    },
  };
}
