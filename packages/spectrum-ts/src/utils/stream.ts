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
