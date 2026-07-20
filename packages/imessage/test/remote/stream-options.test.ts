import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { describe, expect, it, vi } from "vitest";
import { messages } from "@/remote/stream";

// Spy on core's resumableOrderedStream so we can assert the tuning knobs from
// imessage.config() (bufferLimit / catchUpPageSize) reach every inbound stream
// the provider builds. The real implementation is replaced with an idle
// ManagedStream so mergeStreams still has something to merge.
const resumableSpy = vi.fn<(options: { bufferLimit?: number }) => unknown>();

const idleManaged = () => {
  let closed = false;
  let resolveNext:
    | ((result: IteratorResult<never, undefined>) => void)
    | undefined;
  const close = (): Promise<void> => {
    closed = true;
    resolveNext?.({ done: true, value: undefined });
    resolveNext = undefined;
    return Promise.resolve();
  };
  return {
    close,
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<never, undefined>> =>
          closed
            ? Promise.resolve({ done: true, value: undefined })
            : new Promise((resolve) => {
                resolveNext = resolve;
              }),
        return: (): Promise<IteratorResult<never, undefined>> =>
          close().then(() => ({ done: true, value: undefined })),
      };
    },
  };
};

vi.mock("@spectrum-ts/core/authoring", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@spectrum-ts/core/authoring")>();
  return {
    ...actual,
    resumableOrderedStream: (options: { bufferLimit?: number }) => {
      resumableSpy(options);
      return idleManaged();
    },
  };
});

const remoteClient = (phone: string) => ({
  phone,
  client: {
    groups: { subscribeEvents: vi.fn() },
    messages: { subscribeEvents: vi.fn() },
    polls: { subscribeEvents: vi.fn() },
  } as unknown as AdvancedIMessage,
});

describe("remote iMessage stream tuning", () => {
  it("forwards bufferLimit/catchUpPageSize to every resumable stream", async () => {
    resumableSpy.mockClear();

    // Dedicated line ⇒ message + poll + group streams are all constructed.
    const stream = messages([remoteClient("+15550100")], undefined, {
      bufferLimit: 7,
      catchUpPageSize: 3,
    });
    await stream.close();

    expect(resumableSpy).toHaveBeenCalledTimes(3);
    for (const [options] of resumableSpy.mock.calls) {
      expect(options).toMatchObject({ bufferLimit: 7, catchUpPageSize: 3 });
    }
  });

  it("omits the knobs when config leaves them unset", async () => {
    resumableSpy.mockClear();

    const stream = messages([remoteClient("+15550100")]);
    await stream.close();

    expect(resumableSpy).toHaveBeenCalledTimes(3);
    for (const [options] of resumableSpy.mock.calls) {
      expect(options.bufferLimit).toBeUndefined();
    }
  });
});
