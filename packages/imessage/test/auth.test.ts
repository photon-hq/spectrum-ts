import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeDedicatedTokenData {
  auth: Record<string, string>;
  expiresIn: number;
  numbers: Record<string, string | null>;
  type: "dedicated";
}

interface FakeSharedTokenData {
  expiresIn: number;
  token: string;
  type: "shared";
}

type FakeTokenData = FakeDedicatedTokenData | FakeSharedTokenData;

interface FakeClientOptions {
  address: string;
  autoIdempotency?: boolean;
  retry?: boolean;
  tls?: boolean;
  token: () => Promise<string>;
}

interface FakeClient {
  close: ReturnType<typeof vi.fn>;
}

const initialTokenData: FakeDedicatedTokenData = {
  auth: { "instance-1": "token-1" },
  expiresIn: 3600,
  numbers: { "instance-1": "+15550000001" },
  type: "dedicated",
};

// Builds a dedicated payload from instanceId -> phone, so each test reads as
// the line inventory it is asserting against.
const dedicated = (
  numbers: Record<string, string | null>
): FakeDedicatedTokenData => ({
  auth: Object.fromEntries(
    Object.keys(numbers).map((id) => [id, `token-${id}`])
  ),
  expiresIn: 3600,
  numbers,
  type: "dedicated",
});

const issueImessageTokens = vi.fn(
  (
    _projectId: string,
    _projectSecret: string,
    _signal?: AbortSignal
  ): Promise<FakeTokenData> => Promise.resolve(initialTokenData)
);
const clientOptions: FakeClientOptions[] = [];
const fakeClients: FakeClient[] = [];
const createGrpcClient = vi.fn((options: FakeClientOptions) => {
  clientOptions.push(options);
  const client: FakeClient = { close: vi.fn(() => Promise.resolve()) };
  fakeClients.push(client);
  return client;
});

vi.doMock("@spectrum-ts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spectrum-ts/core")>();
  return {
    ...actual,
    cloud: { ...actual.cloud, issueImessageTokens },
  };
});

vi.doMock("@photon-ai/advanced-imessage/grpc", () => ({ createGrpcClient }));

const { createCloudClients, disposeCloudAuth, getCloudRecover } = await import(
  "@/auth"
);
const { addLineObserver } = await import("@/lines");
const { imessage } = await import("@/index");
const { Spectrum } = await import("@spectrum-ts/core");

// The recover hook runs the same closure the renewal timer does, so it is the
// cheapest way to drive a refresh. It is throttled to one re-mint per 5s.
const FORCE_REFRESH_FLOOR_MS = 5000;

const startClients = async (initial: FakeTokenData) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  issueImessageTokens.mockResolvedValueOnce(initial);
  const clients = await createCloudClients("project-1", "secret-1");
  const recover = getCloudRecover(clients);
  if (!recover) {
    throw new Error("expected cloud recovery hook");
  }

  const refresh = async (next: FakeTokenData): Promise<void> => {
    issueImessageTokens.mockResolvedValueOnce(next);
    await vi.advanceTimersByTimeAsync(FORCE_REFRESH_FLOOR_MS);
    await recover();
    // Settle the fire-and-forget retire of any removed line.
    await vi.advanceTimersByTimeAsync(0);
  };

  return { clients, refresh };
};

describe("imessage cloud auth", () => {
  beforeEach(() => {
    issueImessageTokens.mockReset();
    issueImessageTokens.mockResolvedValue(initialTokenData);
    createGrpcClient.mockClear();
    clientOptions.length = 0;
    fakeClients.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("cleans up earlier explicit clients when a later constructor fails", async () => {
    vi.stubEnv("SPECTRUM_PROJECT_ID", "");
    vi.stubEnv("SPECTRUM_PROJECT_SECRET", "");
    const original = createGrpcClient.getMockImplementation();
    if (!original) {
      throw new Error("missing client constructor");
    }
    const failure = new Error("second explicit client failed");
    createGrpcClient
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => {
        throw failure;
      });
    await expect(
      Spectrum({
        providers: [
          imessage.config({
            clients: [
              {
                address: "127.0.0.1:1",
                phone: "+15550000001",
                token: "test-token",
              },
              {
                address: "127.0.0.1:2",
                phone: "+15550000002",
                token: "test-token",
              },
            ],
          }),
        ],
      })
    ).rejects.toBe(failure);
    expect(fakeClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(issueImessageTokens).not.toHaveBeenCalled();
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
    const response = Promise.withResolvers<FakeTokenData>();
    issueImessageTokens.mockImplementationOnce((_id, _secret, signal) => {
      signal?.addEventListener("abort", () => response.reject(signal.reason), {
        once: true,
      });
      started.resolve();
      return response.promise;
    });
    try {
      const pending = Spectrum({
        projectId: "project-1",
        projectSecret: "secret-1",
        providers: [imessage.config()],
        signal: startup.signal,
      });
      const rejection = expect(pending).rejects.toBe(reason);
      await started.promise;
      expect(issueImessageTokens).toHaveBeenCalledExactlyOnceWith(
        "project-1",
        "secret-1",
        startup.signal
      );
      startup.abort(reason);
      await rejection;
      expect(createGrpcClient).not.toHaveBeenCalled();
      expect(fakeClients).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      startup.abort(reason);
      projectLookup.mockRestore();
      platformsLookup.mockRestore();
    }
  });

  it("uses the startup signal only for the initial token request", async () => {
    vi.useFakeTimers();
    const startup = new AbortController();
    const clients = await createCloudClients(
      "project-1",
      "secret-1",
      startup.signal
    );
    expect(issueImessageTokens.mock.calls[0]?.[2]).toBe(startup.signal);
    startup.abort();
    await vi.advanceTimersByTimeAsync(FORCE_REFRESH_FLOOR_MS);
    await getCloudRecover(clients)?.();
    const refreshSignal = issueImessageTokens.mock.calls[1]?.[2];
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect(refreshSignal).not.toBe(startup.signal);
    expect(refreshSignal?.aborted).toBe(false);
    await disposeCloudAuth(clients);
    expect(refreshSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight refresh before closing clients", async () => {
    vi.useFakeTimers();
    const clients = await createCloudClients("project-1", "secret-1");
    issueImessageTokens.mockImplementationOnce(
      (_id, _secret, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    );
    await vi.advanceTimersByTimeAsync(FORCE_REFRESH_FLOOR_MS);
    const refresh = getCloudRecover(clients)?.().catch(
      (error: unknown) => error
    );
    const signal = issueImessageTokens.mock.calls[1]?.[2];
    await disposeCloudAuth(clients);
    expect(signal?.aborted).toBe(true);
    expect(await refresh).toBe(signal?.reason);
    expect(fakeClients[0]?.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(createGrpcClient).toHaveBeenCalledTimes(1);
    expect(issueImessageTokens).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes partial clients and cancels renewal when a later constructor throws", async () => {
    vi.useFakeTimers();
    const original = createGrpcClient.getMockImplementation();
    if (!original) {
      throw new Error("missing client constructor");
    }
    createGrpcClient
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => {
        throw new Error("second client failed");
      });
    issueImessageTokens.mockResolvedValueOnce(
      dedicated({ first: "+15550000001", second: "+15550000002" })
    );
    await expect(createCloudClients("project-1", "secret-1")).rejects.toThrow(
      "second client failed"
    );
    expect(fakeClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hide failed cleanup of a partially constructed client", async () => {
    vi.useFakeTimers();
    const original = createGrpcClient.getMockImplementation();
    if (!original) {
      throw new Error("missing client constructor");
    }
    const failure = new Error("second client failed");
    const cleanupFailure = new Error("close failed");
    createGrpcClient
      .mockImplementationOnce((options) => {
        const client = original(options);
        client.close.mockRejectedValue(cleanupFailure);
        return client;
      })
      .mockImplementationOnce(() => {
        throw failure;
      });
    issueImessageTokens.mockResolvedValueOnce(
      dedicated({ first: "+15550000001", second: "+15550000002" })
    );
    await expect(
      createCloudClients("project-1", "secret-1")
    ).rejects.toMatchObject({
      name: "SpectrumStartupCleanupError",
      cause: failure,
      errors: [expect.objectContaining({ errors: [cleanupFailure] })],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces forced recovery and updates dedicated clients in place", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveRefresh:
      | ((
          value: FakeDedicatedTokenData | PromiseLike<FakeDedicatedTokenData>
        ) => void)
      | undefined;
    issueImessageTokens.mockResolvedValueOnce(initialTokenData);
    issueImessageTokens.mockImplementationOnce(
      () =>
        new Promise<FakeDedicatedTokenData>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const clients = await createCloudClients("project-1", "secret-1");
    const recover = getCloudRecover(clients);
    if (!recover) {
      throw new Error("expected cloud recovery hook");
    }

    await vi.advanceTimersByTimeAsync(5000);
    const first = recover();
    const second = recover();
    expect(issueImessageTokens).toHaveBeenCalledTimes(2);

    resolveRefresh?.({
      auth: { "instance-1": "token-2" },
      expiresIn: 3600,
      numbers: { "instance-1": "+15550000002" },
      type: "dedicated",
    });
    await Promise.all([first, second]);

    expect(issueImessageTokens).toHaveBeenCalledTimes(2);
    expect(clients[0]?.phone).toBe("+15550000002");
    expect(await clientOptions[0]?.token()).toBe("token-2");

    await disposeCloudAuth(clients);
    expect(getCloudRecover(clients)).toBeUndefined();
  });

  it("attaches a line provisioned after startup", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );
    const arrayRef = clients;

    await refresh(
      dedicated({ "instance-1": "+15550000001", "instance-2": "+15550000002" })
    );

    expect(clients).toHaveLength(2);
    expect(clients.map((entry) => entry.phone)).toEqual([
      "+15550000001",
      "+15550000002",
    ]);
    expect(createGrpcClient).toHaveBeenCalledTimes(2);
    // The array is mutated, never replaced: the cloud-auth, poll-cache, and
    // profile-sync WeakMaps are all keyed by its identity.
    expect(clients).toBe(arrayRef);
    expect(getCloudRecover(arrayRef)).toBeDefined();

    await disposeCloudAuth(clients);
  });

  it("builds an added line with the same client options as startup", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );

    await refresh(
      dedicated({ "instance-1": "+15550000001", "instance-2": "+15550000002" })
    );

    const [first, second] = clientOptions;
    const transport = (options?: FakeClientOptions) => ({
      autoIdempotency: options?.autoIdempotency,
      retry: options?.retry,
      tls: options?.tls,
    });
    expect(transport(second)).toEqual(transport(first));
    expect(second?.address).toBe("instance-2.imsg.photon.codes:443");
    expect(await second?.token()).toBe("token-instance-2");

    await disposeCloudAuth(clients);
  });

  it("detaches a deprovisioned line and closes its channel", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001", "instance-2": "+15550000002" })
    );
    expect(clients).toHaveLength(2);

    await refresh(dedicated({ "instance-2": "+15550000002" }));

    expect(clients).toHaveLength(1);
    expect(clients[0]?.phone).toBe("+15550000002");
    expect(fakeClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(fakeClients[1]?.close).not.toHaveBeenCalled();

    await disposeCloudAuth(clients);
  });

  it.each([
    "pending-success",
    "pending-failure",
    "failed",
  ])("owns removed-line cleanup until disposal (%s)", async (mode) => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );
    const close = Promise.withResolvers<void>();
    const failure = new Error("removed line close failed");
    fakeClients[0]?.close.mockReturnValue(close.promise);
    await refresh(dedicated({}));
    expect(clients).toHaveLength(0);
    expect(fakeClients[0]?.close).toHaveBeenCalledTimes(1);
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

  it("skips a line without a phone number instead of failing startup", async () => {
    const { clients } = await startClients(dedicated({ "instance-1": null }));

    expect(clients).toEqual([]);
    expect(createGrpcClient).not.toHaveBeenCalled();

    await disposeCloudAuth(clients);
  });

  it("picks up a line once its number is assigned", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": null })
    );
    expect(clients).toEqual([]);

    await refresh(dedicated({ "instance-1": "+15550000001" }));

    expect(clients).toHaveLength(1);
    expect(clients[0]?.phone).toBe("+15550000001");

    await disposeCloudAuth(clients);
  });

  it("keeps a known line usable when it loses its number mid-refresh", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );

    await refresh(dedicated({ "instance-1": null }));

    expect(clients).toHaveLength(1);
    expect(clients[0]?.phone).toBe("+15550000001");

    // The refresh must have completed normally: a rejected refresh leaves the
    // token deadline unadvanced, and `refreshIfNeeded` runs on every RPC, so
    // every call on every line would re-mint.
    const calls = issueImessageTokens.mock.calls.length;
    expect(await clientOptions[0]?.token()).toBe("token-instance-1");
    expect(issueImessageTokens).toHaveBeenCalledTimes(calls);

    await disposeCloudAuth(clients);
  });

  it("removes every line when the response reports no lines", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );

    // No lines is a real inventory, not a suspect response: holding the entry
    // would keep routing through a channel whose token no longer refreshes.
    await refresh(dedicated({}));

    expect(clients).toEqual([]);
    expect(fakeClients[0]?.close).toHaveBeenCalledTimes(1);

    await disposeCloudAuth(clients);
  });

  it("leaves shared mode untouched across a refresh", async () => {
    const shared: FakeSharedTokenData = {
      expiresIn: 3600,
      token: "shared-1",
      type: "shared",
    };
    const { clients, refresh } = await startClients(shared);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.phone).toBe("shared");

    await refresh({ ...shared, token: "shared-2" });

    expect(clients).toHaveLength(1);
    expect(createGrpcClient).toHaveBeenCalledTimes(1);
    expect(await clientOptions[0]?.token()).toBe("shared-2");

    await disposeCloudAuth(clients);
  });

  it("re-asserts every known line on refresh so a dropped stream revives", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );
    const attached: string[] = [];
    addLineObserver(clients, {
      attach: (entry) => {
        attached.push(entry.phone);
      },
      detach: () => Promise.resolve(),
    });

    // Same line set: the stream layer drops a line whose stream died, so the
    // refresh must re-assert it rather than assume it is still subscribed.
    await refresh(dedicated({ "instance-1": "+15550000001" }));

    expect(attached).toEqual(["+15550000001"]);
    expect(clients).toHaveLength(1);

    await disposeCloudAuth(clients);
  });

  it("survives an observer that throws while attaching", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );
    addLineObserver(clients, {
      attach: () => {
        throw new Error("observer boom");
      },
      detach: () => Promise.resolve(),
    });

    await refresh(
      dedicated({ "instance-1": "+15550000001", "instance-2": "+15550000002" })
    );

    expect(clients).toHaveLength(2);

    await disposeCloudAuth(clients);
  });
});
