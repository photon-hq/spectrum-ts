import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeDedicatedTokenData {
  auth: Record<string, string>;
  expiresIn: number;
  numbers: Record<string, string | null>;
  type: "dedicated";
}

interface FakeClientOptions {
  token: () => Promise<string>;
}

const initialTokenData: FakeDedicatedTokenData = {
  auth: { "instance-1": "token-1" },
  expiresIn: 3600,
  numbers: { "instance-1": "+15550000001" },
  type: "dedicated",
};

const issueImessageTokens = vi.fn(() => Promise.resolve(initialTokenData));
const clientOptions: FakeClientOptions[] = [];
const createClient = vi.fn((options: FakeClientOptions) => {
  clientOptions.push(options);
  return {};
});

vi.doMock("@spectrum-ts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spectrum-ts/core")>();
  return {
    ...actual,
    cloud: { ...actual.cloud, issueImessageTokens },
  };
});

vi.doMock("@photon-ai/advanced-imessage", () => ({ createClient }));

const { createCloudClients, disposeCloudAuth, getCloudRecover } = await import(
  "@/auth"
);

describe("imessage cloud auth", () => {
  beforeEach(() => {
    issueImessageTokens.mockReset();
    issueImessageTokens.mockResolvedValue(initialTokenData);
    createClient.mockClear();
    clientOptions.length = 0;
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
});
