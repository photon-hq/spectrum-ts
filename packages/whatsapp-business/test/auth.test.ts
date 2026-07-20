import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTokenResponse {
  auth: Record<string, string>;
  expiresIn: number;
}

const issueWhatsappBusinessTokens = vi.fn(
  async (): Promise<FakeTokenResponse> => ({
    auth: { "phone-1": "token-1" },
    expiresIn: 0,
  })
);

interface FakeRawClient {
  close: ReturnType<typeof vi.fn>;
  events: {
    fetchMissed: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  media: Record<string, never>;
  messages: {
    markRead: ReturnType<typeof vi.fn>;
  };
  options: { accessToken: string };
}

const rawClients: FakeRawClient[] = [];
let tokenIssueCount = 0;

const WAIT_FOR_TIMEOUT_MS = 250;
const WAIT_FOR_POLL_INTERVAL_MS = 1;
const SCHEDULED_RENEWAL_DELAY_MS = 5000;
const REFRESH_RETRY_DELAY_MS = 30_000;

class FakeTypedEventStream<T> implements AsyncIterable<T> {
  private cancelResolve: (() => void) | undefined;
  private closed = false;
  private consumed = false;
  private readonly cleanup: (() => Promise<void>) | undefined;
  private readonly source: AsyncIterable<T>;

  constructor(source: AsyncIterable<T>, cleanup?: () => Promise<void>) {
    this.source = source;
    this.cleanup = cleanup;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.closed) {
      throw new Error("Cannot consume a closed TypedEventStream.");
    }
    if (this.consumed) {
      throw new Error("TypedEventStream already has a consumer.");
    }
    this.consumed = true;
    return this.iterate();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelResolve?.();
    await this.cleanup?.();
  }

  private async *iterate(): AsyncGenerator<T> {
    const iterator = this.source[Symbol.asyncIterator]();
    try {
      while (!this.closed) {
        const result = await Promise.race([
          iterator.next(),
          this.cancelPromise(),
        ]);
        if (result === undefined || this.closed || result.done) {
          break;
        }
        yield result.value;
      }
    } finally {
      await iterator.return?.(undefined);
    }
  }

  private cancelPromise(): Promise<undefined> {
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.cancelResolve = () => resolve(undefined);
    });
  }
}

const neverSettlingSource = (): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => new Promise<IteratorResult<unknown>>(() => undefined),
      return: () => new Promise<IteratorResult<unknown>>(() => undefined),
    };
  },
});

const createClient = vi.fn((options: { accessToken: string }) => {
  const raw: FakeRawClient = {
    close: vi.fn(() => Promise.resolve()),
    events: {
      fetchMissed: vi.fn(() => Promise.resolve({ events: [] })),
      subscribe: vi.fn(() => new FakeTypedEventStream(neverSettlingSource())),
    },
    media: {},
    messages: {
      markRead: vi.fn(() => Promise.resolve()),
    },
    options,
  };
  rawClients.push(raw);
  return raw;
});

vi.doMock("@spectrum-ts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spectrum-ts/core")>();
  return {
    ...actual,
    cloud: { ...actual.cloud, issueWhatsappBusinessTokens },
  };
});

vi.doMock("@photon-ai/whatsapp-business", () => ({
  createClient,
  TypedEventStream: FakeTypedEventStream,
}));

const { createCloudClients, disposeCloudAuth, subscribeLineAdded } =
  await import("@/auth");

const waitFor = async (
  predicate: () => boolean,
  message: string
): Promise<void> => {
  const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, WAIT_FOR_POLL_INTERVAL_MS)
    );
  }
  throw new Error(message);
};

describe("whatsapp cloud auth stream renewal", () => {
  beforeEach(() => {
    rawClients.length = 0;
    tokenIssueCount = 0;
    issueWhatsappBusinessTokens.mockReset();
    issueWhatsappBusinessTokens.mockImplementation(async () => ({
      auth: { "phone-1": `token-${++tokenIssueCount}` },
      expiresIn: 0,
    }));
    createClient.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a fresh subscription after token refresh even when the old SDK iterator does not return", async () => {
    const clients = await createCloudClients("project-1", "secret-1");
    const eventStream = clients[0]?.client.events.subscribe();
    if (!eventStream) {
      throw new Error("expected a WhatsApp event stream");
    }

    const iterator = eventStream[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    await waitFor(
      () => rawClients[0]?.events.subscribe.mock.calls.length === 1,
      "initial subscription did not start"
    );

    await clients[0]?.client.messages.markRead("wamid.1");

    await waitFor(
      () => rawClients[1]?.events.subscribe.mock.calls.length === 1,
      "subscription did not reopen after token refresh"
    );

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(rawClients[0]?.options.accessToken).toBe("token-1");
    expect(rawClients[1]?.options.accessToken).toBe("token-2");
    expect(rawClients[0]?.close).toHaveBeenCalledTimes(1);

    await eventStream.close();
    await disposeCloudAuth(clients);
    expect((await pendingNext).done).toBe(true);
  });

  it("coalesces concurrent near-expiry refresh requests", async () => {
    let resolveRefresh:
      | ((value: FakeTokenResponse | PromiseLike<FakeTokenResponse>) => void)
      | undefined;

    issueWhatsappBusinessTokens.mockImplementationOnce(async () => ({
      auth: { "phone-1": "token-1" },
      expiresIn: 0,
    }));
    issueWhatsappBusinessTokens.mockImplementationOnce(
      () =>
        new Promise<FakeTokenResponse>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const clients = await createCloudClients("project-1", "secret-1");
    const firstMarkRead = clients[0]?.client.messages.markRead("wamid.1");
    const secondMarkRead = clients[0]?.client.messages.markRead("wamid.2");

    await waitFor(
      () => issueWhatsappBusinessTokens.mock.calls.length === 2,
      "refresh did not start"
    );

    expect(issueWhatsappBusinessTokens).toHaveBeenCalledTimes(2);
    resolveRefresh?.({ auth: { "phone-1": "token-2" }, expiresIn: 0 });

    await Promise.all([firstMarkRead, secondMarkRead]);

    expect(issueWhatsappBusinessTokens).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(rawClients[1]?.options.accessToken).toBe("token-2");
    expect(rawClients[1]?.messages.markRead).toHaveBeenCalledTimes(2);

    await disposeCloudAuth(clients);
  });

  it("picks up a line added to the project at runtime", async () => {
    issueWhatsappBusinessTokens.mockImplementationOnce(async () => ({
      auth: { "phone-1": "token-1" },
      expiresIn: 0,
    }));
    issueWhatsappBusinessTokens.mockImplementationOnce(async () => ({
      auth: { "phone-1": "token-2", "phone-2": "token-2b" },
      expiresIn: 0,
    }));

    const clients = await createCloudClients("project-1", "secret-1");
    expect(clients.map((c) => c.line)).toEqual(["phone-1"]);

    const added: string[] = [];
    const unsubscribe = subscribeLineAdded(clients, (entry) => {
      added.push(entry.line);
    });

    // expiresIn 0 → any proxy RPC refreshes first, pulling the new payload.
    await clients[0]?.client.messages.markRead("wamid.1");

    expect(clients.map((c) => c.line)).toEqual(["phone-1", "phone-2"]);
    expect(added).toEqual(["phone-2"]);

    // The late-added line's proxy routes RPCs to its own raw client
    // (rawClients[2]: raw0 = initial phone-1, raw1 = refreshed phone-1,
    // raw2 = phone-2).
    await clients[1]?.client.messages.markRead("wamid.2");
    expect(rawClients[2]?.messages.markRead).toHaveBeenCalledWith("wamid.2");

    unsubscribe?.();
    await disposeCloudAuth(clients);
  });

  it("drops a line removed from the project at runtime", async () => {
    issueWhatsappBusinessTokens.mockImplementationOnce(async () => ({
      auth: { "phone-1": "token-1", "phone-2": "token-1b" },
      expiresIn: 0,
    }));
    issueWhatsappBusinessTokens.mockImplementationOnce(async () => ({
      auth: { "phone-1": "token-2" },
      expiresIn: 0,
    }));

    const clients = await createCloudClients("project-1", "secret-1");
    expect(clients.map((c) => c.line)).toEqual(["phone-1", "phone-2"]);

    const removedLineStream = clients[1]?.client.events.subscribe();
    if (!removedLineStream) {
      throw new Error("expected a WhatsApp event stream");
    }
    const iterator = removedLineStream[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    // expiresIn 0 → any proxy RPC refreshes first, pulling the new payload.
    await clients[0]?.client.messages.markRead("wamid.1");

    // The stale entry is gone, so outbound routing for spaces tagged with
    // phone-2 falls back to an active line instead of a dead client.
    expect(clients.map((c) => c.line)).toEqual(["phone-1"]);

    // rawClients: raw0 = phone-1, raw1 = phone-2, raw2 = refreshed phone-1.
    expect(rawClients[1]?.close).toHaveBeenCalledTimes(1);
    expect((await pendingNext).done).toBe(true);

    await disposeCloudAuth(clients);
  });

  it("retries a failed scheduled refresh after the retry delay", async () => {
    vi.useFakeTimers();

    issueWhatsappBusinessTokens.mockImplementationOnce(async () => ({
      auth: { "phone-1": "token-1" },
      expiresIn: 0,
    }));
    issueWhatsappBusinessTokens.mockImplementationOnce(() =>
      Promise.reject(new Error("refresh failed"))
    );
    issueWhatsappBusinessTokens.mockImplementationOnce(async () => ({
      auth: { "phone-1": "token-2" },
      expiresIn: 0,
    }));

    const clients = await createCloudClients("project-1", "secret-1");

    await vi.advanceTimersByTimeAsync(SCHEDULED_RENEWAL_DELAY_MS);
    expect(issueWhatsappBusinessTokens).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS - 1);
    expect(issueWhatsappBusinessTokens).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(issueWhatsappBusinessTokens).toHaveBeenCalledTimes(3);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(rawClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(rawClients[1]?.options.accessToken).toBe("token-2");

    await disposeCloudAuth(clients);
  });
});
