import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTokenResponse {
  auth: Record<string, string>;
  expiresIn: number;
}

const issueWhatsappBusinessTokens = vi.fn(
  async (
    _projectId: string,
    _projectSecret: string,
    _signal?: AbortSignal
  ): Promise<FakeTokenResponse> => ({
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

const { createCloudClients, disposeCloudAuth } = await import("@/auth");
const { addLineObserver } = await import("@/lines");
const { whatsappBusiness } = await import("@/index");

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

  it("forwards lifecycle cancellation to the initial token request without creating clients", async () => {
    vi.useFakeTimers();
    const actualCore =
      await vi.importActual<typeof import("@spectrum-ts/core")>(
        "@spectrum-ts/core"
      );
    const projectLookup = vi
      .spyOn(actualCore.cloud, "getProject")
      .mockResolvedValue({
        id: "project-1",
        name: "Test project",
        profile: {},
        slug: "test-project",
      });
    const platformsLookup = vi
      .spyOn(actualCore.cloud, "getPlatforms")
      .mockResolvedValue({
        imessage: { enabled: false },
        slack: { enabled: false },
        whatsapp_business: { enabled: false },
      });
    const startup = new AbortController();
    const reason = new DOMException("startup deadline", "TimeoutError");
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<FakeTokenResponse>();
    issueWhatsappBusinessTokens.mockImplementationOnce(
      (_id, _secret, signal) => {
        signal?.addEventListener(
          "abort",
          () => response.reject(signal.reason),
          {
            once: true,
          }
        );
        started.resolve();
        return response.promise;
      }
    );
    try {
      const pending = actualCore.Spectrum({
        projectId: "project-1",
        projectSecret: "secret-1",
        providers: [whatsappBusiness.config()],
        signal: startup.signal,
      });
      const rejection = expect(pending).rejects.toBe(reason);
      await started.promise;
      expect(issueWhatsappBusinessTokens).toHaveBeenCalledExactlyOnceWith(
        "project-1",
        "secret-1",
        startup.signal
      );
      startup.abort(reason);
      await rejection;
      expect(createClient).not.toHaveBeenCalled();
      expect(rawClients).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      startup.abort(reason);
      projectLookup.mockRestore();
      platformsLookup.mockRestore();
    }
  });

  it("keeps successful client renewals independent of the startup signal", async () => {
    vi.useFakeTimers();
    const startup = new AbortController();
    const clients = await createCloudClients(
      "project-1",
      "secret-1",
      startup.signal
    );
    expect(issueWhatsappBusinessTokens.mock.calls[0]?.[2]).toBe(startup.signal);
    startup.abort();
    await clients[0]?.messages.markRead("test-message");
    const refreshSignal = issueWhatsappBusinessTokens.mock.calls[1]?.[2];
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect(refreshSignal).not.toBe(startup.signal);
    expect(refreshSignal?.aborted).toBe(false);
    await disposeCloudAuth(clients);
    expect(refreshSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending scheduled refresh without recreating clients after disposal", async () => {
    vi.useFakeTimers();
    const clients = await createCloudClients("project-1", "secret-1");
    issueWhatsappBusinessTokens.mockImplementationOnce(
      (_id, _secret, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    );
    await vi.advanceTimersByTimeAsync(SCHEDULED_RENEWAL_DELAY_MS);
    const signal = issueWhatsappBusinessTokens.mock.calls[1]?.[2];
    await disposeCloudAuth(clients);
    expect(signal?.aborted).toBe(true);
    expect(rawClients[0]?.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(issueWhatsappBusinessTokens).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up existing lines and renewal if a later line constructor fails", async () => {
    vi.useFakeTimers();
    const original = createClient.getMockImplementation();
    if (!original) {
      throw new Error("missing client constructor");
    }
    const failure = new Error("second line failed");
    createClient.mockImplementationOnce(original).mockImplementationOnce(() => {
      throw failure;
    });
    issueWhatsappBusinessTokens.mockResolvedValueOnce({
      auth: { first: "first-token", second: "second-token" },
      expiresIn: 3600,
    });
    await expect(createCloudClients("project-1", "secret-1")).rejects.toBe(
      failure
    );
    expect(rawClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces partial line cleanup failures separately from the startup failure", async () => {
    vi.useFakeTimers();
    const original = createClient.getMockImplementation();
    if (!original) {
      throw new Error("missing client constructor");
    }
    const failure = new Error("second line failed");
    const cleanupFailure = new Error("close failed");
    createClient
      .mockImplementationOnce((options) => {
        const client = original(options);
        client.close.mockRejectedValue(cleanupFailure);
        return client;
      })
      .mockImplementationOnce(() => {
        throw failure;
      });
    issueWhatsappBusinessTokens.mockResolvedValueOnce({
      auth: { first: "first-token", second: "second-token" },
      expiresIn: 3600,
    });
    await expect(
      createCloudClients("project-1", "secret-1")
    ).rejects.toMatchObject({
      name: "SpectrumStartupCleanupError",
      cause: failure,
      errors: [expect.objectContaining({ errors: [cleanupFailure] })],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps disposal pending until an old client close actually finishes", async () => {
    const clients = await createCloudClients("project-1", "secret-1");
    const oldClosed = Promise.withResolvers<void>();
    rawClients[0]?.close.mockReturnValueOnce(oldClosed.promise);
    const request = clients[0]?.messages
      .markRead("test-message")
      .catch((error: unknown) => error);
    await waitFor(
      () => rawClients.length === 2,
      "refresh did not replace the client"
    );
    let disposed = false;
    const disposal = disposeCloudAuth(clients).then(() => {
      disposed = true;
    });
    await Promise.resolve();
    try {
      expect(disposed).toBe(false);
      expect(rawClients[1]?.close).not.toHaveBeenCalled();
    } finally {
      oldClosed.resolve();
      await disposal;
    }
    expect(await request).toMatchObject({ name: "AbortError" });
    expect(rawClients[1]?.close).toHaveBeenCalledTimes(1);
    expect(rawClients[1]?.messages.markRead).not.toHaveBeenCalled();
    expect(rawClients).toHaveLength(2);
  });

  it.each([
    "pending-success",
    "pending-failure",
    "failed",
  ])("owns removed-line cleanup until disposal (%s)", async (mode) => {
    vi.useFakeTimers();
    const clients = await createCloudClients("project-1", "secret-1");
    const close = Promise.withResolvers<void>();
    const failure = new Error("removed line close failed");
    rawClients[0]?.close.mockReturnValue(close.promise);
    issueWhatsappBusinessTokens.mockResolvedValueOnce({
      auth: {},
      expiresIn: 3600,
    });
    await vi.advanceTimersByTimeAsync(SCHEDULED_RENEWAL_DELAY_MS);
    expect(clients).toHaveLength(0);
    expect(rawClients[0]?.close).toHaveBeenCalledTimes(1);
    if (mode === "failed") {
      close.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
    }
    let settled = false;
    const disposal = disposeCloudAuth(clients)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      if (mode !== "failed") {
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
      }
    } finally {
      if (mode === "pending-success") {
        close.resolve();
      } else {
        close.reject(failure);
      }
      await disposal;
    }
    if (mode === "pending-success") {
      expect(await disposal).toBeUndefined();
    } else {
      expect(await disposal).toMatchObject({ errors: [failure] });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports failed cleanup of a client replaced during renewal", async () => {
    vi.useFakeTimers();
    const clients = await createCloudClients("project-1", "secret-1");
    const failure = new Error("replaced client close failed");
    rawClients[0]?.close.mockRejectedValue(failure);
    await vi.advanceTimersByTimeAsync(SCHEDULED_RENEWAL_DELAY_MS);
    await expect(disposeCloudAuth(clients)).rejects.toMatchObject({
      errors: [failure],
    });
    expect(rawClients[1]?.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens a fresh subscription after token refresh even when the old SDK iterator does not return", async () => {
    const clients = await createCloudClients("project-1", "secret-1");
    const eventStream = clients[0]?.events.subscribe();
    if (!eventStream) {
      throw new Error("expected a WhatsApp event stream");
    }

    const iterator = eventStream[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    await waitFor(
      () => rawClients[0]?.events.subscribe.mock.calls.length === 1,
      "initial subscription did not start"
    );

    await clients[0]?.messages.markRead("wamid.1");

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
    const firstMarkRead = clients[0]?.messages.markRead("wamid.1");
    const secondMarkRead = clients[0]?.messages.markRead("wamid.2");

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

describe("whatsapp cloud line reconciliation", () => {
  beforeEach(() => {
    rawClients.length = 0;
    tokenIssueCount = 0;
    issueWhatsappBusinessTokens.mockReset();
    createClient.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // `expiresIn: 0` makes every proxied RPC refresh, so `markRead` is the cheapest
  // way to drive the same closure the renewal timer runs.
  const respondWith = (auth: Record<string, string>): void => {
    issueWhatsappBusinessTokens.mockImplementation(async () => ({
      auth,
      expiresIn: 0,
    }));
  };

  it("attaches a line provisioned after startup", async () => {
    respondWith({ "phone-1": "token-1" });
    const clients = await createCloudClients("project-1", "secret-1");
    const arrayRef = clients;
    expect(clients).toHaveLength(1);

    respondWith({ "phone-1": "token-1b", "phone-2": "token-2" });
    await clients[0]?.messages.markRead("wamid.1");

    expect(clients).toHaveLength(2);
    // The array is mutated, never replaced: the cloud-auth state is keyed by
    // its identity.
    expect(clients).toBe(arrayRef);

    await disposeCloudAuth(clients);
  });

  it("detaches a deprovisioned line and closes it", async () => {
    respondWith({ "phone-1": "token-1", "phone-2": "token-2" });
    const clients = await createCloudClients("project-1", "secret-1");
    expect(clients).toHaveLength(2);

    respondWith({ "phone-1": "token-1b" });
    await clients[0]?.messages.markRead("wamid.1");

    expect(clients).toHaveLength(1);
    // rawClients[1] is the deprovisioned line's underlying client.
    await waitFor(
      () => rawClients[1]?.close.mock.calls.length === 1,
      "deprovisioned line was not closed"
    );

    await disposeCloudAuth(clients);
  });

  it("removes every line when the response reports no lines", async () => {
    respondWith({ "phone-1": "token-1" });
    const clients = await createCloudClients("project-1", "secret-1");

    // No lines is a real inventory, not a suspect response: holding the entry
    // would keep routing through a line whose token no longer refreshes.
    respondWith({});
    await clients[0]?.messages.markRead("wamid.1");

    expect(clients).toEqual([]);
    await waitFor(
      () => rawClients[0]?.close.mock.calls.length === 1,
      "removed line was not closed"
    );

    await disposeCloudAuth(clients);
  });

  it("notifies observers about attached and detached lines", async () => {
    respondWith({ "phone-1": "token-1" });
    const clients = await createCloudClients("project-1", "secret-1");
    // Records whether the array already agreed with the notification when the
    // observer ran — an observer must never see a half-applied array.
    const attached: boolean[] = [];
    const detached: boolean[] = [];
    addLineObserver(clients, {
      attach: (client) => {
        attached.push(clients.includes(client));
      },
      detach: (client) => {
        detached.push(clients.includes(client));
      },
    });

    respondWith({ "phone-1": "token-1b", "phone-2": "token-2" });
    await clients[0]?.messages.markRead("wamid.1");
    // Both lines are attached: the existing one is re-asserted (which is what
    // revives a line whose stream died) and the new one is added.
    expect(attached).toEqual([true, true]);

    respondWith({ "phone-2": "token-2b" });
    await clients[0]?.messages.markRead("wamid.2");
    await waitFor(() => detached.length === 1, "detach was not observed");
    // Spliced out before the observer runs, mirroring the attach ordering.
    expect(detached).toEqual([false]);
    expect(clients).toHaveLength(1);

    await disposeCloudAuth(clients);
  });
});
