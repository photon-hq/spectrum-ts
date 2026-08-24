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
  (): Promise<FakeTokenData> => Promise.resolve(initialTokenData)
);

interface FakeListedLine {
  createdAt: string;
  id: string;
  phoneNumber: string;
  platform: "imessage";
  profile: {
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  };
  status: "available" | "unavailable" | "unknown";
}

// One member of the polled `GET /lines` inventory, keyed by phone number —
// the field discovery diffs against the tracked client set.
const listedLine = (phone: string): FakeListedLine => ({
  platform: "imessage",
  id: `id-${phone}`,
  phoneNumber: phone,
  profile: { firstName: null, lastName: null, avatarUrl: null },
  status: "available",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const listLines = vi.fn(
  (): Promise<{ lines: FakeListedLine[] }> => Promise.resolve({ lines: [] })
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
    cloud: { ...actual.cloud, issueImessageTokens, listLines },
  };
});

vi.doMock("@photon-ai/advanced-imessage/grpc", () => ({ createGrpcClient }));

const { createCloudClients, disposeCloudAuth, getCloudRecover, refreshLines } =
  await import("@/auth");
const { addLineObserver } = await import("@/lines");
const { IMESSAGE_PLATFORM } = await import("@/platform");

// Minimal SpectrumLike shape: refreshLines only reads
// `__internal.platforms.get("imessage").client`.
const fakeApp = (client: unknown) =>
  ({
    __internal: {
      platforms: new Map([[IMESSAGE_PLATFORM, { client }]]),
    },
    __providers: [],
  }) as unknown as Parameters<typeof refreshLines>[0];

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
    listLines.mockReset();
    listLines.mockResolvedValue({ lines: [] });
    createGrpcClient.mockClear();
    clientOptions.length = 0;
    fakeClients.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
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

  describe("line discovery", () => {
    const DISCOVERY_INTERVAL_MS = 10_000;

    const startWithDiscovery = async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      issueImessageTokens.mockResolvedValueOnce(
        dedicated({ "instance-1": "+15550000001" })
      );
      return await createCloudClients("project-1", "secret-1", {
        lineDiscovery: { intervalMs: DISCOVERY_INTERVAL_MS },
      });
    };

    it("attaches a provisioned line at the next inventory poll", async () => {
      const clients = await startWithDiscovery();
      expect(clients).toHaveLength(1);

      listLines.mockResolvedValue({
        lines: [listedLine("+15550000001"), listedLine("+15550000002")],
      });
      issueImessageTokens.mockResolvedValueOnce(
        dedicated({
          "instance-1": "+15550000001",
          "instance-2": "+15550000002",
        })
      );

      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);

      expect(listLines).toHaveBeenCalledWith(
        "project-1",
        "secret-1",
        "imessage"
      );
      expect(clients).toHaveLength(2);
      expect(clients.map((entry) => entry.phone)).toEqual([
        "+15550000001",
        "+15550000002",
      ]);

      await disposeCloudAuth(clients);
    });

    it("does not re-mint while the inventory matches", async () => {
      const clients = await startWithDiscovery();
      listLines.mockResolvedValue({ lines: [listedLine("+15550000001")] });

      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS * 2);

      expect(listLines).toHaveBeenCalledTimes(2);
      // Startup mint only — a matching poll must not touch the token endpoint.
      expect(issueImessageTokens).toHaveBeenCalledTimes(1);
      expect(clients).toHaveLength(1);

      await disposeCloudAuth(clients);
    });

    it("recovers from a failed poll on the next tick", async () => {
      const clients = await startWithDiscovery();
      listLines.mockRejectedValueOnce(new Error("poll boom"));
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);
      expect(clients).toHaveLength(1);

      listLines.mockResolvedValue({
        lines: [listedLine("+15550000001"), listedLine("+15550000002")],
      });
      issueImessageTokens.mockResolvedValueOnce(
        dedicated({
          "instance-1": "+15550000001",
          "instance-2": "+15550000002",
        })
      );
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);

      expect(clients).toHaveLength(2);

      await disposeCloudAuth(clients);
    });

    it("does not re-mint when a poll lands after dispose", async () => {
      const clients = await startWithDiscovery();
      let resolvePoll:
        | ((value: { lines: FakeListedLine[] }) => void)
        | undefined;
      listLines.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          })
      );

      // The tick fires and the poll is in flight when the client is disposed;
      // its late result must not trigger a mint against a torn-down client.
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);
      await disposeCloudAuth(clients);
      resolvePoll?.({
        lines: [listedLine("+15550000001"), listedLine("+15550000002")],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(issueImessageTokens).toHaveBeenCalledTimes(1);
      expect(clients).toHaveLength(1);
    });

    it("damps re-minting while the same drift persists", async () => {
      const clients = await startWithDiscovery();
      // The mint keeps returning the single-line payload (the beforeEach
      // default), so the second listed line can never attach: the exact wedged
      // state the damp exists for.
      listLines.mockResolvedValue({
        lines: [listedLine("+15550000001"), listedLine("+15550000002")],
      });

      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);
      // Startup + the first drift mint.
      expect(issueImessageTokens).toHaveBeenCalledTimes(2);

      // The same drift signature is damped, not re-minted every tick.
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS * 4);
      expect(issueImessageTokens).toHaveBeenCalledTimes(2);

      // Damp window elapsed: one retry.
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);
      expect(issueImessageTokens).toHaveBeenCalledTimes(3);

      // A drift with a new shape re-mints immediately.
      listLines.mockResolvedValue({
        lines: [
          listedLine("+15550000001"),
          listedLine("+15550000002"),
          listedLine("+15550000003"),
        ],
      });
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);
      expect(issueImessageTokens).toHaveBeenCalledTimes(4);

      await disposeCloudAuth(clients);
    });

    it("stops polling once the client is disposed", async () => {
      const clients = await startWithDiscovery();

      await disposeCloudAuth(clients);
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS * 3);

      expect(listLines).not.toHaveBeenCalled();
    });

    it("can be disabled via config", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      issueImessageTokens.mockResolvedValueOnce(
        dedicated({ "instance-1": "+15550000001" })
      );
      const clients = await createCloudClients("project-1", "secret-1", {
        lineDiscovery: { enabled: false },
      });

      await vi.advanceTimersByTimeAsync(120_000);

      expect(listLines).not.toHaveBeenCalled();

      await disposeCloudAuth(clients);
    });

    it("does not poll in shared mode", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      issueImessageTokens.mockResolvedValueOnce({
        expiresIn: 3600,
        token: "shared-1",
        type: "shared",
      });
      const clients = await createCloudClients("project-1", "secret-1", {
        lineDiscovery: { intervalMs: DISCOVERY_INTERVAL_MS },
      });

      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS * 3);

      expect(listLines).not.toHaveBeenCalled();

      await disposeCloudAuth(clients);
    });
  });

  describe("refreshLines", () => {
    it("chains behind an in-flight refresh instead of coalescing onto it", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      issueImessageTokens.mockResolvedValueOnce(
        dedicated({ "instance-1": "+15550000001" })
      );
      const clients = await createCloudClients("project-1", "secret-1");
      const recover = getCloudRecover(clients);
      if (!recover) {
        throw new Error("expected cloud recovery hook");
      }

      // A refresh already in flight, minted BEFORE the new line existed.
      let resolveStale: ((value: FakeTokenData) => void) | undefined;
      issueImessageTokens.mockImplementationOnce(
        () =>
          new Promise<FakeTokenData>((resolve) => {
            resolveStale = resolve;
          })
      );
      await vi.advanceTimersByTimeAsync(5000);
      const stale = recover();

      issueImessageTokens.mockResolvedValueOnce(
        dedicated({
          "instance-1": "+15550000001",
          "instance-2": "+15550000002",
        })
      );
      const refreshed = refreshLines(fakeApp(clients));

      resolveStale?.(dedicated({ "instance-1": "+15550000001" }));
      await stale;
      await refreshed;

      // The stale payload alone would have left one line; refreshLines must
      // resolve on a mint that started after the call.
      expect(clients).toHaveLength(2);

      await disposeCloudAuth(clients);
    });

    it("re-mints immediately, even within the forced-refresh floor", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      issueImessageTokens.mockResolvedValueOnce(
        dedicated({ "instance-1": "+15550000001" })
      );
      const clients = await createCloudClients("project-1", "secret-1");

      // No timer advance: still inside the 5s floor that throttles the
      // stream-recovery hook. A deliberate refresh must not be skipped.
      issueImessageTokens.mockResolvedValueOnce(
        dedicated({
          "instance-1": "+15550000001",
          "instance-2": "+15550000002",
        })
      );
      await refreshLines(fakeApp(clients));

      expect(clients).toHaveLength(2);
      expect(clients.map((entry) => entry.phone)).toEqual([
        "+15550000001",
        "+15550000002",
      ]);

      await disposeCloudAuth(clients);
    });

    it("is a no-op for explicitly-configured clients", async () => {
      // A static client array never passes through createCloudClients, so it
      // has no cloud auth state to refresh.
      await refreshLines(fakeApp([]));

      expect(issueImessageTokens).not.toHaveBeenCalled();
    });

    it("throws when the instance has no iMessage provider", async () => {
      const app = {
        __internal: { platforms: new Map() },
        __providers: [],
      } as unknown as Parameters<typeof refreshLines>[0];

      await expect(refreshLines(app)).rejects.toThrow(
        "no iMessage provider is registered"
      );
    });
  });
});
