import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface HttpClientOptions {
  address: string;
  autoIdempotency: boolean;
  retry: boolean;
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

const LINE_ONE_ID = "11111111-1111-4111-8111-111111111111";
const LINE_TWO_ID = "22222222-2222-4222-8222-222222222222";
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
const getImessageInfo = vi.fn();
const issueImessageResourceToken = vi.fn();
const issueImessageTokens = vi.fn();
const fetchMock = vi.fn();

const tokenProvider = {
  dispose: vi.fn(() => Promise.resolve()),
  getToken: vi.fn(() => Promise.resolve("fusor-token")),
  invalidate: vi.fn(),
};
const createFusorTokenProvider = vi.fn(() => Promise.resolve(tokenProvider));

const renewal = {
  dispose: vi.fn(),
  forceRefresh: vi.fn(() => Promise.resolve()),
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
    cloud: {
      ...actual.cloud,
      getImessageInfo,
      issueImessageResourceToken,
      issueImessageTokens,
    },
  };
});

vi.doMock("@spectrum-ts/core/authoring", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@spectrum-ts/core/authoring")>();
  return {
    ...actual,
    createFusorTokenProvider,
    createTokenRenewal,
  };
});

vi.doMock("@photon-ai/advanced-imessage/http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@photon-ai/advanced-imessage/http")>();
  return { ...actual, createHttpClient };
});

const { createCloudClients, disposeCloudAuth } = await import("@/auth");
const { imessage } = await import("@/index");

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const dedicatedLines = () => ({
  lines: [
    { lineId: LINE_ONE_ID, phoneNumber: "+15550100" },
    { lineId: LINE_TWO_ID, phoneNumber: "+15550101" },
  ],
});

const resourceTokens = (token = "resource-token") => ({
  expiresIn: 3600,
  token,
});

const resolveClientToken = async (client: FakeClient): Promise<string> =>
  await client.options.token();

describe("iMessage cloud authentication", () => {
  beforeEach(() => {
    issuedClients.length = 0;
    renewalOptions = undefined;
    createHttpClient.mockReset();
    createHttpClient.mockImplementation(makeFakeClient);
    getImessageInfo.mockReset();
    issueImessageResourceToken.mockReset();
    issueImessageResourceToken.mockResolvedValue(resourceTokens());
    issueImessageTokens.mockReset();
    createFusorTokenProvider.mockClear();
    createTokenRenewal.mockClear();
    fetchMock.mockReset();
    tokenProvider.dispose.mockClear();
    tokenProvider.getToken.mockReset();
    tokenProvider.getToken.mockResolvedValue("fusor-token");
    tokenProvider.invalidate.mockClear();
    renewal.dispose.mockClear();
    renewal.forceRefresh.mockClear();
    renewal.invalidate.mockClear();
    renewal.refreshIfNeeded.mockClear();
    renewal.refreshIfNeeded.mockResolvedValue();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the legacy Cloud token and HTTP endpoint in shared mode", async () => {
    getImessageInfo.mockResolvedValue({ type: "shared" });
    issueImessageTokens.mockResolvedValue({
      expiresIn: 3600,
      token: "shared-token",
      type: "shared",
    });

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(getImessageInfo).toHaveBeenCalledWith(PROJECT_ID, PROJECT_SECRET);
    expect(issueImessageTokens).toHaveBeenCalledWith(
      PROJECT_ID,
      PROJECT_SECRET
    );
    expect(issueImessageResourceToken).not.toHaveBeenCalled();
    expect(createFusorTokenProvider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("uses the dedicated HTTP adapter override for shared mode", async () => {
    vi.stubEnv(
      "SPECTRUM_IMESSAGE_HTTP_ADDRESS",
      "https://staging-imessage-http.photon.codes"
    );
    getImessageInfo.mockResolvedValue({ type: "shared" });
    issueImessageTokens.mockResolvedValue({
      expiresIn: 3600,
      token: "shared-token",
      type: "shared",
    });

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(issuedClients[0]?.options.address).toBe(
      "https://staging-imessage-http.photon.codes"
    );
    await disposeCloudAuth(clients);
  });

  it("uses refreshed shared credentials without rebuilding the client", async () => {
    getImessageInfo.mockResolvedValue({ type: "shared" });
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

  it("discovers dedicated lines with a Fusor bearer and creates one HTTP client per line", async () => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    fetchMock.mockResolvedValue(jsonResponse(dedicatedLines()));

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);

    expect(createFusorTokenProvider).toHaveBeenCalledWith(
      PROJECT_ID,
      PROJECT_SECRET
    );
    expect(issueImessageResourceToken).toHaveBeenCalledWith(
      PROJECT_ID,
      PROJECT_SECRET
    );
    expect(issueImessageTokens).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input?.toString()).toBe(
      "https://fusor-imessage.spectrum.photon.codes/v1/lines"
    );
    expect(init).toEqual(
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      })
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fusor-token"
    );
    expect(clients).toEqual([
      {
        client: issuedClients[1] as unknown as AdvancedIMessage,
        lineId: LINE_ONE_ID,
        phone: "+15550100",
        resourceClient: issuedClients[0] as unknown as AdvancedIMessage,
      },
      {
        client: issuedClients[2] as unknown as AdvancedIMessage,
        lineId: LINE_TWO_ID,
        phone: "+15550101",
        resourceClient: issuedClients[0] as unknown as AdvancedIMessage,
      },
    ]);
    expect(issuedClients.map(({ options }) => options.address)).toEqual([
      "imessage-http.photon.codes",
      `https://fusor-imessage.spectrum.photon.codes/lines/${LINE_ONE_ID}`,
      `https://fusor-imessage.spectrum.photon.codes/lines/${LINE_TWO_ID}`,
    ]);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "resource-token"
    );
    expect(await resolveClientToken(issuedClients[1] as FakeClient)).toBe(
      "fusor-token"
    );

    await disposeCloudAuth(clients);
    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("renews the dedicated project resource token without rebuilding clients", async () => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    issueImessageResourceToken
      .mockResolvedValueOnce(resourceTokens("resource-token-1"))
      .mockResolvedValueOnce(resourceTokens("resource-token-2"));
    fetchMock.mockResolvedValue(jsonResponse(dedicatedLines()));

    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    await renewalOptions?.refresh();

    expect(renewalOptions?.name).toBe("imessage-resource");
    expect(renewalOptions?.expiresInSeconds()).toBe(3600);
    expect(await resolveClientToken(issuedClients[0] as FakeClient)).toBe(
      "resource-token-2"
    );
    expect(createHttpClient).toHaveBeenCalledTimes(3);
    expect(issueImessageResourceToken).toHaveBeenCalledTimes(2);

    await disposeCloudAuth(clients);
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("closes a shared dedicated resource client exactly once", async () => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    fetchMock.mockResolvedValue(jsonResponse(dedicatedLines()));
    const clients = await createCloudClients(PROJECT_ID, PROJECT_SECRET);
    const destroyClient = imessage.config({}).__definition.lifecycle
      .destroyClient;

    await destroyClient?.({ client: clients } as never);

    expect(issuedClients).toHaveLength(3);
    for (const issued of issuedClients) {
      expect(issued.close).toHaveBeenCalledOnce();
    }
    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("invalidates the Fusor token, retries once, and rejects an empty topology", async () => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    tokenProvider.getToken
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce("fresh-token");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ lines: [] }));

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("Dedicated iMessage gateway returned no ready lines");

    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")
    ).toBe("Bearer expired-token");
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")
    ).toBe("Bearer fresh-token");

    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(issueImessageResourceToken).not.toHaveBeenCalled();
    expect(createTokenRenewal).not.toHaveBeenCalled();
    expect(renewal.dispose).not.toHaveBeenCalled();
  });

  it("rejects a plaintext dedicated gateway before sending a bearer token", async () => {
    vi.stubEnv(
      "SPECTRUM_IMESSAGE_GATEWAY_ADDRESS",
      "http://fusor-imessage.internal"
    );
    getImessageInfo.mockResolvedValue({ type: "dedicated" });

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("Invalid dedicated iMessage gateway address");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(createHttpClient).not.toHaveBeenCalled();
    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(issueImessageResourceToken).not.toHaveBeenCalled();
    expect(renewal.dispose).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an invalid line id",
      response: {
        lines: [{ lineId: "not-a-uuid", phoneNumber: "+15550100" }],
      },
    },
    {
      name: "an invalid phone",
      response: {
        lines: [{ lineId: LINE_ONE_ID, phoneNumber: "5550100" }],
      },
    },
    {
      name: "an unknown response field",
      response: { lines: [], unexpected: true },
    },
  ])("rejects discovery containing $name and disposes auth", async (testCase) => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    fetchMock.mockResolvedValue(jsonResponse(testCase.response));

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow();

    expect(issueImessageResourceToken).not.toHaveBeenCalled();
    expect(createHttpClient).not.toHaveBeenCalled();
    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(renewal.dispose).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: `duplicate line ${LINE_ONE_ID}`,
      lines: [
        { lineId: LINE_ONE_ID, phoneNumber: "+15550100" },
        { lineId: LINE_ONE_ID, phoneNumber: "+15550101" },
      ],
      name: "line ids",
    },
    {
      expected: "duplicate phone +15550100",
      lines: [
        { lineId: LINE_ONE_ID, phoneNumber: "+15550100" },
        { lineId: LINE_TWO_ID, phoneNumber: "+15550100" },
      ],
      name: "phone numbers",
    },
  ])("rejects duplicate dedicated $name before opening clients", async (testCase) => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    fetchMock.mockResolvedValue(jsonResponse({ lines: testCase.lines }));

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow(testCase.expected);

    expect(createHttpClient).not.toHaveBeenCalled();
    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(issueImessageResourceToken).not.toHaveBeenCalled();
    expect(renewal.dispose).not.toHaveBeenCalled();
  });

  it("closes already-opened clients when dedicated client construction fails", async () => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    fetchMock.mockResolvedValue(jsonResponse(dedicatedLines()));
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
    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(renewal.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a missing historical resource token and disposes Fusor auth", async () => {
    getImessageInfo.mockResolvedValue({ type: "dedicated" });
    issueImessageResourceToken.mockResolvedValue(resourceTokens(""));
    fetchMock.mockResolvedValue(jsonResponse(dedicatedLines()));

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("resource token response is missing token");

    expect(createFusorTokenProvider).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(createHttpClient).not.toHaveBeenCalled();
    expect(tokenProvider.dispose).toHaveBeenCalledOnce();
    expect(renewal.dispose).not.toHaveBeenCalled();
  });

  it("fails closed when shared mode receives dedicated credentials", async () => {
    getImessageInfo.mockResolvedValue({ type: "shared" });
    issueImessageTokens.mockResolvedValue({
      auth: {},
      expiresIn: 3600,
      numbers: {},
      type: "dedicated",
    });

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow(
      "iMessage mode discovery returned shared but token issuance returned dedicated"
    );

    expect(createHttpClient).not.toHaveBeenCalled();
    expect(createFusorTokenProvider).not.toHaveBeenCalled();
  });

  it("fails closed when Cloud returns an unknown iMessage mode", async () => {
    getImessageInfo.mockResolvedValue({ type: "future-mode" });

    await expect(
      createCloudClients(PROJECT_ID, PROJECT_SECRET)
    ).rejects.toThrow("Unsupported iMessage mode returned by Spectrum Cloud");

    expect(issueImessageTokens).not.toHaveBeenCalled();
    expect(issueImessageResourceToken).not.toHaveBeenCalled();
    expect(createFusorTokenProvider).not.toHaveBeenCalled();
    expect(createHttpClient).not.toHaveBeenCalled();
  });
});
