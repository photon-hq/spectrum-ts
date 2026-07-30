import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
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

interface HttpClientOptions {
  address: string;
  autoIdempotency: boolean;
  retry: boolean;
  server?: string;
  token: () => Promise<string>;
}

interface FakeClient {
  close: ReturnType<typeof vi.fn>;
  options: HttpClientOptions;
}

interface RenewalOptions {
  expiresInSeconds: () => number;
  name: string;
  refresh: () => Promise<void>;
}

const INSTANCE_ONE = "instance-one";
const INSTANCE_TWO = "instance-two";
const INSTANCE_THREE = "instance-three";
const PHONE_ONE = "+15550100";
const PHONE_TWO = "+15550101";
const PHONE_THREE = "+15550102";
const PROJECT_ID = "project-1";
const PROJECT_SECRET = "secret-1";
const FORCE_REFRESH_FLOOR_MS = 5000;

const issuedClients: FakeClient[] = [];
const makeFakeClient = (options: HttpClientOptions): AdvancedIMessage => {
  const client: FakeClient = {
    close: vi.fn(() => Promise.resolve()),
    options,
  };
  issuedClients.push(client);
  return client as unknown as AdvancedIMessage;
};

const createHttpClient = vi.fn(makeFakeClient);
const issueImessageTokens = vi.fn<() => Promise<FakeTokenData>>();

const renewal = {
  dispose: vi.fn(),
  forceRefresh: vi.fn<() => Promise<void>>(),
  invalidate: vi.fn(),
  refreshIfNeeded: vi.fn(() => Promise.resolve()),
};
let renewalOptions: RenewalOptions | undefined;
const createTokenRenewal = vi.fn((options: RenewalOptions) => {
  renewalOptions = options;
  return renewal;
});

vi.doMock("@spectrum-ts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spectrum-ts/core")>();
  return {
    ...actual,
    cloud: { ...actual.cloud, issueImessageTokens },
  };
});

vi.doMock("@spectrum-ts/core/authoring", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@spectrum-ts/core/authoring")>();
  return { ...actual, createTokenRenewal };
});

vi.doMock("@photon-ai/advanced-imessage/http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@photon-ai/advanced-imessage/http")>();
  return { ...actual, createHttpClient };
});

const { createCloudClients, disposeCloudAuth, getCloudRecover } = await import(
  "@/auth"
);

const dedicatedTokens = (
  overrides: Partial<{
    auth: Record<string, string>;
    expiresIn: number;
    numbers: Record<string, string | null>;
  }> = {}
): FakeDedicatedTokenData => ({
  auth: {
    [INSTANCE_ONE]: "token-one",
    [INSTANCE_TWO]: "token-two",
  },
  expiresIn: 3600,
  numbers: {
    [INSTANCE_ONE]: PHONE_ONE,
    [INSTANCE_TWO]: PHONE_TWO,
  },
  type: "dedicated",
  ...overrides,
});

const dedicatedInventory = (
  numbers: Record<string, string | null>
): FakeDedicatedTokenData => ({
  auth: Object.fromEntries(
    Object.keys(numbers).map((instanceId) => [
      instanceId,
      `token-${instanceId}`,
    ])
  ),
  expiresIn: 3600,
  numbers,
  type: "dedicated",
});

const resolveClientToken = async (client: FakeClient): Promise<string> =>
  await client.options.token();

const refreshWith = async (next: FakeTokenData): Promise<void> => {
  issueImessageTokens.mockResolvedValueOnce(next);
  if (!renewalOptions) {
    throw new Error("expected renewal options");
  }
  await renewalOptions.refresh();
};

describe("iMessage cloud authentication", () => {
  beforeEach(() => {
    issuedClients.length = 0;
    renewalOptions = undefined;
    createHttpClient.mockReset();
    createHttpClient.mockImplementation(makeFakeClient);
    issueImessageTokens.mockReset();
    issueImessageTokens.mockResolvedValue(dedicatedTokens());
    createTokenRenewal.mockClear();
    renewal.dispose.mockClear();
    renewal.forceRefresh.mockReset();
    renewal.forceRefresh.mockImplementation(async () => {
      if (!renewalOptions) {
        throw new Error("expected renewal options");
      }
      await renewalOptions.refresh();
    });
    renewal.invalidate.mockClear();
    renewal.refreshIfNeeded.mockClear();
    renewal.refreshIfNeeded.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("uses the Cloud token and shared HTTP endpoint in shared mode", async () => {
    issueImessageTokens.mockResolvedValue({
      expiresIn: 3600,
      token: "shared-token",
      type: "shared",
    });

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(issueImessageTokens).toHaveBeenCalledWith(
      PROJECT_ID,
      PROJECT_SECRET
    );
    expect(clients).toEqual([
      {
        client: issuedClients[0] as unknown as AdvancedIMessage,
        phone: "shared",
      },
    ]);
    expect(issuedClients[0]?.options).toEqual({
      address: "imessage-http.photon.codes",
      autoIdempotency: true,
      retry: true,
      token: expect.any(Function),
    });
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "shared-token"
    );
    expect(renewal.refreshIfNeeded).toHaveBeenCalledOnce();

    await disposeCloudAuth(clients);
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("uses the HTTP adapter override for dedicated clients", async () => {
    vi.stubEnv(
      "SPECTRUM_IMESSAGE_HTTP_ADDRESS",
      "https://staging-imessage-http.photon.codes"
    );

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(issuedClients.map(({ options }) => options.address)).toEqual([
      "https://staging-imessage-http.photon.codes",
      "https://staging-imessage-http.photon.codes",
    ]);
    await disposeCloudAuth(clients);
  });

  it("uses refreshed shared credentials without rebuilding the client", async () => {
    issueImessageTokens.mockResolvedValueOnce({
      expiresIn: 60,
      token: "shared-token-1",
      type: "shared",
    });
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    await refreshWith({
      expiresIn: 3600,
      token: "shared-token-2",
      type: "shared",
    });

    expect(renewalOptions?.name).toBe("imessage");
    expect(renewalOptions?.expiresInSeconds()).toBe(3600);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "shared-token-2"
    );
    expect(createHttpClient).toHaveBeenCalledOnce();
    await disposeCloudAuth(clients);
  });

  it("creates one direct HTTP client per Cloud instance", async () => {
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(clients).toEqual([
      {
        client: issuedClients[0] as unknown as AdvancedIMessage,
        phone: PHONE_ONE,
      },
      {
        client: issuedClients[1] as unknown as AdvancedIMessage,
        phone: PHONE_TWO,
      },
    ]);
    expect(issuedClients.map(({ options }) => options)).toEqual([
      {
        address: "imessage-http.photon.codes",
        autoIdempotency: true,
        retry: true,
        server: INSTANCE_ONE,
        token: expect.any(Function),
      },
      {
        address: "imessage-http.photon.codes",
        autoIdempotency: true,
        retry: true,
        server: INSTANCE_TWO,
        token: expect.any(Function),
      },
    ]);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "token-one"
    );
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      "token-two"
    );
    await disposeCloudAuth(clients);
  });

  it("rotates dedicated tokens without rebuilding clients", async () => {
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    await refreshWith(
      dedicatedTokens({
        auth: {
          [INSTANCE_ONE]: "token-one-refreshed",
          [INSTANCE_TWO]: "token-two-refreshed",
        },
      })
    );

    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "token-one-refreshed"
    );
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      "token-two-refreshed"
    );
    expect(createHttpClient).toHaveBeenCalledTimes(2);
    await disposeCloudAuth(clients);
  });

  it("adds a newly provisioned line to the same live array", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: PHONE_ONE })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const arrayIdentity = clients;

    await refreshWith(
      dedicatedInventory({
        [INSTANCE_ONE]: PHONE_ONE,
        [INSTANCE_TWO]: PHONE_TWO,
      })
    );

    expect(clients).toBe(arrayIdentity);
    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE, PHONE_TWO]);
    expect(issuedClients[1]?.options.server).toBe(INSTANCE_TWO);
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      `token-${INSTANCE_TWO}`
    );
    expect(getCloudRecover(arrayIdentity)).toBeDefined();
    await disposeCloudAuth(clients);
  });

  it("removes and closes a deprovisioned line without replacing the array", async () => {
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const arrayIdentity = clients;

    await refreshWith(dedicatedInventory({ [INSTANCE_TWO]: PHONE_TWO }));

    expect(clients).toBe(arrayIdentity);
    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_TWO]);
    expect(issuedClients[0]?.close).toHaveBeenCalledOnce();
    expect(issuedClients[1]?.close).not.toHaveBeenCalled();
    await disposeCloudAuth(clients);
  });

  it("updates a changed phone on its existing instance client", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: PHONE_ONE })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const entryIdentity = clients[0];

    await refreshWith(dedicatedInventory({ [INSTANCE_ONE]: "+15550199" }));

    expect(clients).toHaveLength(1);
    expect(clients[0]).toBe(entryIdentity);
    expect(clients[0]?.phone).toBe("+15550199");
    expect(createHttpClient).toHaveBeenCalledOnce();
    await disposeCloudAuth(clients);
  });

  it("skips a provisioned line until Cloud assigns its phone", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: null })
    );

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(clients).toEqual([]);
    expect(createHttpClient).not.toHaveBeenCalled();
    await disposeCloudAuth(clients);
  });

  it("discovers a previously unassigned line on refresh", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: null })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    await refreshWith(dedicatedInventory({ [INSTANCE_ONE]: PHONE_ONE }));

    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE]);
    expect(issuedClients[0]?.options.server).toBe(INSTANCE_ONE);
    await disposeCloudAuth(clients);
  });

  it("keeps a known line's last phone when Cloud temporarily omits it", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedTokens({
        auth: { [INSTANCE_ONE]: "token-one" },
        numbers: { [INSTANCE_ONE]: PHONE_ONE },
      })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const entryIdentity = clients[0];

    await refreshWith(
      dedicatedTokens({
        auth: { [INSTANCE_ONE]: "token-one-refreshed" },
        numbers: { [INSTANCE_ONE]: null },
      })
    );

    expect(clients).toEqual([entryIdentity]);
    expect(clients[0]?.phone).toBe(PHONE_ONE);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "token-one-refreshed"
    );
    expect(createHttpClient).toHaveBeenCalledOnce();
    await disposeCloudAuth(clients);
  });

  it("lets a discovered assignment replace a colliding preserved phone", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: PHONE_ONE })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const originalClient = issuedClients[0];

    await refreshWith(
      dedicatedTokens({
        auth: {
          [INSTANCE_ONE]: "token-one-refreshed",
          [INSTANCE_TWO]: "token-two",
        },
        numbers: {
          [INSTANCE_ONE]: null,
          [INSTANCE_TWO]: PHONE_ONE,
        },
      })
    );

    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE]);
    expect(issuedClients[1]?.options.server).toBe(INSTANCE_TWO);
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      "token-two"
    );
    expect(originalClient?.close).toHaveBeenCalledOnce();
    await disposeCloudAuth(clients);
  });

  it("forces immediate discovery once, then bounds repeated refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: PHONE_ONE })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const recover = getCloudRecover(clients);
    if (!recover) {
      throw new Error("expected cloud recovery hook");
    }
    issueImessageTokens
      .mockResolvedValueOnce(
        dedicatedInventory({
          [INSTANCE_ONE]: PHONE_ONE,
          [INSTANCE_TWO]: PHONE_TWO,
        })
      )
      .mockResolvedValueOnce(
        dedicatedInventory({
          [INSTANCE_ONE]: PHONE_ONE,
          [INSTANCE_TWO]: PHONE_TWO,
          [INSTANCE_THREE]: PHONE_THREE,
        })
      );

    await expect(recover()).resolves.toBe(true);
    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE, PHONE_TWO]);
    expect(renewal.forceRefresh).toHaveBeenCalledOnce();

    await expect(recover()).resolves.toBe(false);
    expect(renewal.forceRefresh).toHaveBeenCalledOnce();
    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE, PHONE_TWO]);

    await vi.advanceTimersByTimeAsync(FORCE_REFRESH_FLOOR_MS);
    await expect(recover()).resolves.toBe(true);
    expect(renewal.forceRefresh).toHaveBeenCalledTimes(2);
    expect(clients.map(({ phone }) => phone)).toEqual([
      PHONE_ONE,
      PHONE_TWO,
      PHONE_THREE,
    ]);
    await disposeCloudAuth(clients);
  });

  it("coalesces callers but keeps an in-flight piggyback retryable", async () => {
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const recover = getCloudRecover(clients);
    if (!recover) {
      throw new Error("expected cloud recovery hook");
    }
    let release: (() => void) | undefined;
    renewal.forceRefresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = recover();
    const second = recover();
    expect(renewal.forceRefresh).toHaveBeenCalledOnce();
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);

    await disposeCloudAuth(clients);
  });

  it("reports an unsuccessful refresh as stale during the retry floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const recover = getCloudRecover(clients);
    if (!recover) {
      throw new Error("expected cloud recovery hook");
    }
    renewal.forceRefresh.mockRejectedValueOnce(new Error("cloud unavailable"));

    await expect(recover()).rejects.toThrow("cloud unavailable");
    await expect(recover()).resolves.toBe(false);
    expect(renewal.forceRefresh).toHaveBeenCalledOnce();

    await disposeCloudAuth(clients);
  });

  it.each([
    {
      expected: `missing auth for instance ${INSTANCE_ONE}`,
      response: dedicatedTokens({
        auth: { [INSTANCE_ONE]: "" },
        numbers: { [INSTANCE_ONE]: PHONE_ONE },
      }),
    },
    {
      expected: `instance ${INSTANCE_ONE} has no valid E.164 phone`,
      response: dedicatedTokens({
        auth: { [INSTANCE_ONE]: "token-one" },
        numbers: { [INSTANCE_ONE]: "15550100" },
      }),
    },
    {
      expected: `duplicate phone ${PHONE_ONE}`,
      response: dedicatedTokens({
        numbers: {
          [INSTANCE_ONE]: PHONE_ONE,
          [INSTANCE_TWO]: PHONE_ONE,
        },
      }),
    },
  ])("rejects invalid dedicated discovery: $expected", async (testCase) => {
    issueImessageTokens.mockResolvedValue(testCase.response);

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow(testCase.expected);

    expect(createHttpClient).not.toHaveBeenCalled();
    expect(createTokenRenewal).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: "returned shared credentials",
      refreshed: { expiresIn: 3600, token: "shared", type: "shared" },
    },
    {
      expected: `missing auth for instance ${INSTANCE_ONE}`,
      refreshed: dedicatedTokens({
        auth: {
          [INSTANCE_ONE]: " ",
          [INSTANCE_TWO]: "token-two-refreshed",
        },
      }),
    },
    {
      expected: `instance ${INSTANCE_ONE} has no valid E.164 phone`,
      refreshed: dedicatedTokens({
        numbers: {
          [INSTANCE_ONE]: "invalid",
          [INSTANCE_TWO]: PHONE_TWO,
        },
      }),
    },
    {
      expected: `duplicate phone ${PHONE_ONE}`,
      refreshed: dedicatedTokens({
        numbers: {
          [INSTANCE_ONE]: PHONE_ONE,
          [INSTANCE_TWO]: PHONE_ONE,
        },
      }),
    },
  ])("rejects an invalid refresh that $expected", async (testCase) => {
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const arrayIdentity = clients;

    await expect(
      refreshWith(testCase.refreshed as FakeTokenData)
    ).rejects.toThrow(testCase.expected);

    expect(clients).toBe(arrayIdentity);
    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE, PHONE_TWO]);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "token-one"
    );
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      "token-two"
    );
    expect(
      issuedClients.every(({ close }) => close.mock.calls.length === 0)
    ).toBe(true);
    await disposeCloudAuth(clients);
  });

  it("preserves an empty dedicated project and discovers its first line", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedTokens({ auth: {}, numbers: {} })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const recover = getCloudRecover(clients);
    if (!recover) {
      throw new Error("expected cloud recovery hook");
    }
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: PHONE_ONE })
    );

    expect(clients).toEqual([]);
    await expect(recover()).resolves.toBe(true);

    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE]);
    expect(createHttpClient).toHaveBeenCalledOnce();
    await disposeCloudAuth(clients);
  });

  it("closes already-opened clients when construction fails", async () => {
    createHttpClient
      .mockImplementationOnce(makeFakeClient)
      .mockImplementationOnce(() => {
        throw new Error("client construction failed");
      });

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("client construction failed");

    expect(issuedClients).toHaveLength(1);
    expect(issuedClients[0]?.close).toHaveBeenCalledOnce();
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("contains a removed client's close failure", async () => {
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    issuedClients[0]?.close.mockRejectedValueOnce(new Error("close failed"));

    await expect(
      refreshWith(dedicatedInventory({ [INSTANCE_TWO]: PHONE_TWO }))
    ).resolves.toBeUndefined();

    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_TWO]);
    expect(issuedClients[0]?.close).toHaveBeenCalledOnce();
    await disposeCloudAuth(clients);
  });

  it("disposes renewal state once and disables a retained recovery hook", async () => {
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const recover = getCloudRecover(clients);
    if (!recover) {
      throw new Error("expected cloud recovery hook");
    }

    await disposeCloudAuth(clients);
    await disposeCloudAuth(clients);
    await expect(recover()).resolves.toBe(false);

    expect(renewal.dispose).toHaveBeenCalledOnce();
    expect(renewal.forceRefresh).not.toHaveBeenCalled();
    expect(getCloudRecover(clients)).toBeUndefined();
  });

  it("does not add a line when an in-flight refresh finishes after disposal", async () => {
    issueImessageTokens.mockResolvedValueOnce(
      dedicatedInventory({ [INSTANCE_ONE]: PHONE_ONE })
    );
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    let resolveRefresh: ((value: FakeDedicatedTokenData) => void) | undefined;
    issueImessageTokens.mockImplementationOnce(
      () =>
        new Promise<FakeTokenData>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    if (!renewalOptions) {
      throw new Error("expected renewal options");
    }

    const refreshing = renewalOptions.refresh();
    await disposeCloudAuth(clients);
    resolveRefresh?.(
      dedicatedInventory({
        [INSTANCE_ONE]: PHONE_ONE,
        [INSTANCE_TWO]: PHONE_TWO,
      })
    );
    await refreshing;

    expect(clients.map(({ phone }) => phone)).toEqual([PHONE_ONE]);
    expect(createHttpClient).toHaveBeenCalledOnce();
  });

  it("fails closed when a shared token refresh changes mode", async () => {
    issueImessageTokens.mockResolvedValueOnce({
      expiresIn: 60,
      token: "shared",
      type: "shared",
    });
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    await expect(refreshWith(dedicatedTokens())).rejects.toThrow(
      "Shared iMessage token refresh returned dedicated credentials"
    );
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "shared"
    );
    await disposeCloudAuth(clients);
  });

  it("rejects missing shared tokens at discovery and refresh", async () => {
    issueImessageTokens.mockResolvedValueOnce({
      expiresIn: 3600,
      token: " ",
      type: "shared",
    });
    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("Shared iMessage token response is missing token");
    expect(createTokenRenewal).not.toHaveBeenCalled();

    issueImessageTokens
      .mockResolvedValueOnce({
        expiresIn: 3600,
        token: "shared",
        type: "shared",
      })
      .mockResolvedValueOnce({
        expiresIn: 3600,
        token: "",
        type: "shared",
      });
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    if (!renewalOptions) {
      throw new Error("expected renewal options");
    }
    await expect(renewalOptions.refresh()).rejects.toThrow(
      "Shared iMessage token response is missing token"
    );
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "shared"
    );
    await disposeCloudAuth(clients);
  });

  it("fails closed when Cloud returns an unknown iMessage mode", async () => {
    issueImessageTokens.mockResolvedValue({
      expiresIn: 3600,
      type: "future-mode",
    } as unknown as FakeTokenData);

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("Unsupported iMessage mode returned by Spectrum Cloud");

    expect(createHttpClient).not.toHaveBeenCalled();
  });
});
