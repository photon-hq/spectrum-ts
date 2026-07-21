import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedResumableStreamOptions {
  bufferLimit?: number;
  label?: string;
  subscribeLive: (cursor?: string) => {
    close?: () => Promise<void> | void;
  };
}

const resumableSpy = vi.fn<(options: CapturedResumableStreamOptions) => void>();

const emptyManagedStream = () => ({
  close: () => Promise.resolve(),
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  },
});

const closeClient = vi.fn(() => Promise.resolve());
const emptyGrpcStream = () => ({
  close: () => Promise.resolve(),
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  },
});
const subscribeGroupEvents = vi.fn(emptyGrpcStream);
const subscribeMessageEvents = vi.fn(emptyGrpcStream);
const subscribePollEvents = vi.fn(emptyGrpcStream);
const createGrpcClient = vi.fn(() => ({
  close: closeClient,
  groups: { subscribeEvents: subscribeGroupEvents },
  messages: { subscribeEvents: subscribeMessageEvents },
  polls: { subscribeEvents: subscribePollEvents },
}));

vi.doMock("@photon-ai/advanced-imessage/grpc", async () => {
  const actual = await vi.importActual<
    typeof import("@photon-ai/advanced-imessage/grpc")
  >("@photon-ai/advanced-imessage/grpc");
  return { ...actual, createGrpcClient };
});

vi.doMock("@spectrum-ts/core/authoring", async () => {
  const actual = await vi.importActual<
    typeof import("@spectrum-ts/core/authoring")
  >("@spectrum-ts/core/authoring");
  return {
    ...actual,
    resumableOrderedStream: (options: CapturedResumableStreamOptions) => {
      resumableSpy(options);
      return emptyManagedStream();
    },
  };
});

const { Spectrum } = await import("@spectrum-ts/core");
const { imessage } = await import("@/index");

const CLIENT_CONFIG = {
  address: "line-1.imsg.photon.codes:443",
  phone: "+15550100",
  token: "test-token",
};

const collectStreamOptions = async (
  config: Parameters<typeof imessage.config>[0]
): Promise<CapturedResumableStreamOptions[]> => {
  const app = await Spectrum({ providers: [imessage.config(config)] });
  try {
    const iterator = app.messages[Symbol.asyncIterator]();
    await iterator.next();
    return resumableSpy.mock.calls.map(([options]) => options);
  } finally {
    await app.stop();
  }
};

describe("remote iMessage stream tuning", () => {
  beforeEach(() => {
    closeClient.mockClear();
    createGrpcClient.mockClear();
    resumableSpy.mockClear();
    subscribeGroupEvents.mockClear();
    subscribeMessageEvents.mockClear();
    subscribePollEvents.mockClear();
  });

  it("forwards bufferLimit from imessage.config to every gRPC stream", async () => {
    const options = await collectStreamOptions({
      bufferLimit: 7,
      clients: CLIENT_CONFIG,
    });

    expect(createGrpcClient).toHaveBeenCalledOnce();
    expect(options).toHaveLength(3);
    expect(options.map(({ label }) => label?.split(":")[0])).toEqual([
      "imessage.messages",
      "imessage.polls",
      "imessage.groups",
    ]);
    for (const streamOptions of options) {
      expect(streamOptions).toMatchObject({ bufferLimit: 7 });
      expect(streamOptions).not.toHaveProperty("catchUpPageSize");
      await streamOptions.subscribeLive("5").close?.();
    }
    expect(subscribeMessageEvents).toHaveBeenCalledOnce();
    expect(subscribePollEvents).toHaveBeenCalledOnce();
    expect(subscribeGroupEvents).toHaveBeenCalledOnce();
  });

  it("forwards undefined when imessage.config omits bufferLimit", async () => {
    const options = await collectStreamOptions({ clients: CLIENT_CONFIG });

    expect(options).toHaveLength(3);
    for (const streamOptions of options) {
      expect(streamOptions.bufferLimit).toBeUndefined();
    }
  });
});
