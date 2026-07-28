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

  it("keeps the current set when the response reports no lines", async () => {
    const { clients, refresh } = await startClients(
      dedicated({ "instance-1": "+15550000001" })
    );

    await refresh(dedicated({}));

    expect(clients).toHaveLength(1);
    expect(clients[0]?.phone).toBe("+15550000001");
    expect(fakeClients[0]?.close).not.toHaveBeenCalled();

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
