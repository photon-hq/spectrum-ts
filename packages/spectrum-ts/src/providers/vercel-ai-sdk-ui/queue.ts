// Small push-based AsyncIterable used by the provider's messages() stream.
// This mirrors the terminal provider's event queue, but is generic so the
// browser route can push parsed useChat messages into Spectrum's pull model.
interface QueueState<T> {
  closed: boolean;
  items: T[];
  waiters: Array<(value: IteratorResult<T>) => void>;
}

export interface AsyncQueue<T> {
  close: () => void;
  iter: AsyncIterable<T>;
  push: (value: T) => void;
}

export function makeAsyncQueue<T>(): AsyncQueue<T> {
  const state: QueueState<T> = {
    closed: false,
    items: [],
    waiters: [],
  };

  const drain = () => {
    while (state.waiters.length > 0) {
      state.waiters.shift()?.({ value: undefined, done: true });
    }
  };

  return {
    iter: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (state.closed && state.items.length === 0) {
              return Promise.resolve({ value: undefined, done: true });
            }
            const item = state.items.shift();
            if (item !== undefined) {
              return Promise.resolve({ value: item, done: false });
            }
            return new Promise((resolve) => state.waiters.push(resolve));
          },
          return(): Promise<IteratorResult<T>> {
            state.closed = true;
            drain();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
    push(value: T): void {
      if (state.closed) {
        return;
      }
      const waiter = state.waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
        return;
      }
      state.items.push(value);
    },
    close(): void {
      state.closed = true;
      drain();
    },
  };
}
