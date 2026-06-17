// A single-producer/single-consumer async queue. The chat SDK pushes inbound
// events via callbacks; Spectrum's `messages` producer pulls them as an
// async-iterable. This bridges the two — handlers `push()`, the producer
// drains via the async iterator, and `close()` ends the stream promptly on
// `Spectrum.stop()`.

export interface EventQueue<T> {
  close: () => void;
  readonly iter: AsyncIterable<T>;
  push: (value: T) => void;
}

export function makeEventQueue<T>(): EventQueue<T> {
  const buffer: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const drain = () => {
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined, done: true });
    }
  };

  const iter: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift() as T, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<T>> {
          closed = true;
          drain();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    iter,
    push(value: T) {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        buffer.push(value);
      }
    },
    close() {
      closed = true;
      drain();
    },
  };
}
