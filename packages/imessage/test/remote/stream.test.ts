import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { flush, settleSoon } from "@spectrum-ts/test-support/timing";
import { describe, expect, it, vi } from "vitest";
import { messages } from "@/remote/stream";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const idleEventStream = () => {
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
        next(): Promise<IteratorResult<never, undefined>> {
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        return(): Promise<IteratorResult<never, undefined>> {
          return close().then(() => ({ done: true, value: undefined }));
        },
      };
    },
  };
};

const remoteClient = (phone: string) => {
  const subscribeToMessages = vi.fn(idleEventStream);
  const subscribeToPolls = vi.fn(idleEventStream);
  const subscribeToGroups = vi.fn(idleEventStream);
  const entry: RemoteClient = {
    phone,
    client: {
      groups: { subscribeEvents: subscribeToGroups },
      messages: { subscribeEvents: subscribeToMessages },
      polls: { subscribeEvents: subscribeToPolls },
    } as unknown as AdvancedIMessage,
  };

  return {
    entry,
    subscribeToGroups,
    subscribeToMessages,
    subscribeToPolls,
  };
};

const startAndClose = async (clients: RemoteClient[]): Promise<void> => {
  const stream = messages(clients);
  const pendingMessage = stream[Symbol.asyncIterator]().next();
  await flush();
  await stream.close();
  await settleSoon(pendingMessage);
};

describe("remote iMessage streams", () => {
  it("does not subscribe to group events in shared mode", async () => {
    const shared = remoteClient(SHARED_PHONE);

    await startAndClose([shared.entry]);

    expect(shared.subscribeToMessages).toHaveBeenCalledTimes(1);
    expect(shared.subscribeToPolls).toHaveBeenCalledTimes(1);
    expect(shared.subscribeToGroups).not.toHaveBeenCalled();
  });

  it("subscribes to group events for a dedicated line", async () => {
    const dedicated = remoteClient("+15550100");

    await startAndClose([dedicated.entry]);

    expect(dedicated.subscribeToMessages).toHaveBeenCalledTimes(1);
    expect(dedicated.subscribeToPolls).toHaveBeenCalledTimes(1);
    expect(dedicated.subscribeToGroups).toHaveBeenCalledTimes(1);
  });
});
