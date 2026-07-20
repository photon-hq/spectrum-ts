import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const PHONE_ONE = "+15550100";
const PHONE_TWO = "+15550101";
const PROJECT_ID = "project-1";
const PROJECT_SECRET = "secret-1";

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
const issueImessageTokens = vi.fn();

const renewal = {
  dispose: vi.fn(),
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

const { createCloudClients, disposeCloudAuth } = await import("@/auth");
const { imessage } = await import("@/index");

const dedicatedTokens = (
  overrides: Partial<{
    auth: Record<string, string>;
    expiresIn: number;
    numbers: Record<string, string | null>;
  }> = {}
) => ({
  auth: {
    [INSTANCE_ONE]: "token-one",
    [INSTANCE_TWO]: "token-two",
  },
  expiresIn: 3600,
  numbers: {
    [INSTANCE_ONE]: PHONE_ONE,
    [INSTANCE_TWO]: PHONE_TWO,
  },
  type: "dedicated" as const,
  ...overrides,
});

const resolveClientToken = async (client: FakeClient): Promise<string> =>
  await client.options.token();

describe("iMessage cloud authentication", () => {
  beforeEach(() => {
    issuedClients.length = 0;
    renewalOptions = undefined;
    createHttpClient.mockReset();
    createHttpClient.mockImplementation(makeFakeClient);
    issueImessageTokens.mockReset();
    createTokenRenewal.mockClear();
    renewal.dispose.mockClear();
    renewal.refreshIfNeeded.mockClear();
    renewal.refreshIfNeeded.mockResolvedValue();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

  it("uses the HTTP adapter override in both modes", async () => {
    vi.stubEnv(
      "SPECTRUM_IMESSAGE_HTTP_ADDRESS",
      "https://staging-imessage-http.photon.codes"
    );
    issueImessageTokens.mockResolvedValue(dedicatedTokens());

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(issuedClients.map(({ options }) => options.address)).toEqual([
      "https://staging-imessage-http.photon.codes",
      "https://staging-imessage-http.photon.codes",
    ]);
    await disposeCloudAuth(clients);
  });

  it("uses refreshed shared credentials without rebuilding the client", async () => {
    issueImessageTokens
      .mockResolvedValueOnce({
        expiresIn: 60,
        token: "shared-token-1",
        type: "shared",
      })
      .mockResolvedValueOnce({
        expiresIn: 3600,
        token: "shared-token-2",
        type: "shared",
      });

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    await renewalOptions?.refresh();

    expect(renewalOptions?.name).toBe("imessage");
    expect(renewalOptions?.expiresInSeconds()).toBe(3600);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "shared-token-2"
    );
    expect(createHttpClient).toHaveBeenCalledOnce();

    await disposeCloudAuth(clients);
  });

  it("creates one direct HTTP client per Cloud instance", async () => {
    issueImessageTokens.mockResolvedValue(dedicatedTokens());

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
    expect(createTokenRenewal).toHaveBeenCalledOnce();

    await disposeCloudAuth(clients);
  });

  it("rotates dedicated instance tokens without rebuilding clients", async () => {
    issueImessageTokens
      .mockResolvedValueOnce(dedicatedTokens())
      .mockResolvedValueOnce(
        dedicatedTokens({
          auth: {
            [INSTANCE_ONE]: "token-one-refreshed",
            [INSTANCE_TWO]: "token-two-refreshed",
          },
        })
      );

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    await renewalOptions?.refresh();

    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "token-one-refreshed"
    );
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      "token-two-refreshed"
    );
    expect(createHttpClient).toHaveBeenCalledTimes(2);
    await disposeCloudAuth(clients);
  });

  it.each([
    {
      expected: "returned shared credentials",
      refreshed: { expiresIn: 3600, token: "shared", type: "shared" },
    },
    {
      expected: "changed the dedicated instance set",
      refreshed: dedicatedTokens({
        auth: { [INSTANCE_ONE]: "token-one" },
        numbers: { [INSTANCE_ONE]: PHONE_ONE },
      }),
    },
    {
      expected: `changed the phone for instance ${INSTANCE_ONE}`,
      refreshed: dedicatedTokens({
        numbers: {
          [INSTANCE_ONE]: "+15550199",
          [INSTANCE_TWO]: PHONE_TWO,
        },
      }),
    },
    {
      expected: `missing auth for instance ${INSTANCE_ONE}`,
      refreshed: dedicatedTokens({
        auth: {
          [INSTANCE_ONE]: "",
          [INSTANCE_TWO]: "token-two-refreshed",
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
  ])("rejects a dedicated refresh that $expected", async (testCase) => {
    issueImessageTokens
      .mockResolvedValueOnce(dedicatedTokens())
      .mockResolvedValueOnce(testCase.refreshed);
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    await expect(renewalOptions?.refresh()).rejects.toThrow(testCase.expected);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "token-one"
    );
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      "token-two"
    );

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
        numbers: { [INSTANCE_ONE]: null },
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

  it("preserves the existing empty dedicated project behavior", async () => {
    issueImessageTokens.mockResolvedValue(
      dedicatedTokens({ auth: {}, numbers: {} })
    );

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(clients).toEqual([]);
    expect(createHttpClient).not.toHaveBeenCalled();
    expect(createTokenRenewal).toHaveBeenCalledOnce();

    await disposeCloudAuth(clients);
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("closes already-opened clients when construction fails", async () => {
    issueImessageTokens.mockResolvedValue(dedicatedTokens());
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

  it("closes every dedicated client and its renewal state once", async () => {
    issueImessageTokens.mockResolvedValue(dedicatedTokens());
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const destroyClient = imessage.config({}).__definition.lifecycle
      .destroyClient;

    await destroyClient?.({ client: clients } as never);

    for (const issued of issuedClients) {
      expect(issued.close).toHaveBeenCalledOnce();
    }
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("fails closed when a shared token refresh changes mode", async () => {
    issueImessageTokens
      .mockResolvedValueOnce({
        expiresIn: 60,
        token: "shared",
        type: "shared",
      })
      .mockResolvedValueOnce(dedicatedTokens());
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    await expect(renewalOptions?.refresh()).rejects.toThrow(
      "Shared iMessage token refresh returned dedicated credentials"
    );

    await disposeCloudAuth(clients);
  });

  it("fails closed when Cloud returns an unknown iMessage mode", async () => {
    issueImessageTokens.mockResolvedValue({
      expiresIn: 3600,
      type: "future-mode",
    });

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("Unsupported iMessage mode returned by Spectrum Cloud");

    expect(createHttpClient).not.toHaveBeenCalled();
  });
});
