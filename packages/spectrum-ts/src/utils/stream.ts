import { Repeater } from "@repeaterjs/repeater";

export interface ManagedStream<T> extends AsyncIterable<T> {
  close(): Promise<void>;
}

type StreamCleanup = void | (() => void | Promise<void>);

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
      await repeater.return(undefined);
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
      await Promise.allSettled(workers);
    };
  });
}

export interface Broadcaster<T> {
  close(): Promise<void>;
  subscribe(): ManagedStream<T>;
}

interface BroadcastConsumer<T> {
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
          if (consumers.size === 0) {
            continue;
          }
          await Promise.all(
            Array.from(consumers, (consumer) =>
              consumer.emit(value).catch(() => {
                // consumer closed mid-emit; it will be removed via its cleanup
              })
            )
          );
        }
        terminated = true;
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
        const consumer: BroadcastConsumer<T> = { emit, end };
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
      await source.close();
      if (pumpPromise) {
        await pumpPromise;
      }
      if (!terminated) {
        terminated = true;
        for (const consumer of consumers) {
          consumer.end();
        }
        consumers.clear();
      }
    },
  };
}
