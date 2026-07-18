import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface GrpcClientOptions {
  address: string;
  token: string | (() => Promise<string>);
}

interface FakeClient {
  close: ReturnType<typeof vi.fn>;
  options: GrpcClientOptions;
}

const issuedClients: FakeClient[] = [];
const MISSING_PROXY_TOKEN_ERROR = /missing proxyToken/;
const MISSING_INSTANCE_AUTH_ERROR = /missing auth for instance instance-2/;
const MISSING_INSTANCE_PHONE_ERROR = /instance-2 has no phone/;
const makeFakeClient = (options: GrpcClientOptions): AdvancedIMessage => {
  const client: FakeClient = {
    close: vi.fn(() => Promise.resolve()),
    options,
  };
  issuedClients.push(client);
  return client as unknown as AdvancedIMessage;
};
const createGrpcClient = vi.fn(makeFakeClient);

const issueImessageTokens = vi.fn();

vi.doMock("@spectrum-ts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spectrum-ts/core")>();
  return {
    ...actual,
    cloud: { ...actual.cloud, issueImessageTokens },
  };
});

vi.doMock("@photon-ai/advanced-imessage/grpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@photon-ai/advanced-imessage/grpc")>();
  return { ...actual, createGrpcClient };
});

const { createCloudClients, disposeCloudAuth, getCloudRecover } = await import(
  "@/auth"
);
const { imessage } = await import("@/index");

const dedicatedTokens = (
  proxyToken: string,
  expiresIn = 3600
): {
  auth: Record<string, string>;
  expiresIn: number;
  numbers: Record<string, string>;
  proxyToken: string;
  type: "dedicated";
} => ({
  auth: { "instance-1": "direct-1", "instance-2": "direct-2" },
  expiresIn,
  numbers: {
    "instance-1": "+15550100",
    "instance-2": "+15550101",
  },
  proxyToken,
  type: "dedicated",
});

const resolveToken = async (token: GrpcClientOptions["token"]) =>
  typeof token === "function" ? await token() : token;

describe("iMessage cloud resource client auth", () => {
  beforeEach(() => {
    issuedClients.length = 0;
    createGrpcClient.mockReset();
    createGrpcClient.mockImplementation(makeFakeClient);
    issueImessageTokens.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces forced recovery and updates all dedicated tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveRefresh:
      | ((value: ReturnType<typeof dedicatedTokens>) => void)
      | undefined;
    issueImessageTokens.mockResolvedValueOnce(dedicatedTokens("proxy-1"));
    issueImessageTokens.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof dedicatedTokens>>((resolve) => {
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
      ...dedicatedTokens("proxy-2"),
      auth: {
        "instance-1": "direct-1-refreshed",
        "instance-2": "direct-2-refreshed",
      },
    });
    await Promise.all([first, second]);

    expect(issueImessageTokens).toHaveBeenCalledTimes(2);
    expect(await resolveToken(issuedClients[0]?.options.token ?? "")).toBe(
      "proxy-2"
    );
    expect(await resolveToken(issuedClients[1]?.options.token ?? "")).toBe(
      "direct-1-refreshed"
    );

    await disposeCloudAuth(clients);
    expect(getCloudRecover(clients)).toBeUndefined();
  });

  it("shares one project proxy across all dedicated instance clients", async () => {
    issueImessageTokens.mockResolvedValue(dedicatedTokens("proxy-1"));

    const clients = await createCloudClients("project-1", "secret-1");

    expect(clients).toHaveLength(2);
    expect(createGrpcClient).toHaveBeenCalledTimes(3);
    expect(issuedClients.map((entry) => entry.options.address)).toEqual([
      "imessage.spectrum.photon.codes:443",
      "instance-1.imsg.photon.codes:443",
      "instance-2.imsg.photon.codes:443",
    ]);
    expect(clients[0]?.resourceClient).toBe(clients[1]?.resourceClient);
    expect(clients[0]?.resourceClient).toBe(
      issuedClients[0] as unknown as AdvancedIMessage
    );
    expect(await resolveToken(issuedClients[0]?.options.token ?? "")).toBe(
      "proxy-1"
    );
    expect(await resolveToken(issuedClients[1]?.options.token ?? "")).toBe(
      "direct-1"
    );

    await disposeCloudAuth(clients);
  });

  it("reads the latest proxy token after a cloud refresh", async () => {
    issueImessageTokens
      .mockResolvedValueOnce(dedicatedTokens("proxy-1", 0))
      .mockResolvedValue(dedicatedTokens("proxy-2"));
    const clients = await createCloudClients("project-1", "secret-1");

    expect(await resolveToken(issuedClients[0]?.options.token ?? "")).toBe(
      "proxy-2"
    );
    expect(issueImessageTokens).toHaveBeenCalledTimes(2);

    await disposeCloudAuth(clients);
  });

  it("rejects a dedicated response without a project proxy token", async () => {
    issueImessageTokens.mockResolvedValue(dedicatedTokens(""));

    await expect(createCloudClients("project-1", "secret-1")).rejects.toThrow(
      MISSING_PROXY_TOKEN_ERROR
    );
    expect(createGrpcClient).not.toHaveBeenCalled();
  });

  it("validates every dedicated line before opening any channel", async () => {
    issueImessageTokens.mockResolvedValue({
      ...dedicatedTokens("proxy-1"),
      numbers: { "instance-1": "+15550100" },
    });

    await expect(createCloudClients("project-1", "secret-1")).rejects.toThrow(
      MISSING_INSTANCE_PHONE_ERROR
    );
    expect(createGrpcClient).not.toHaveBeenCalled();
  });

  it("closes channels already opened when later client construction fails", async () => {
    issueImessageTokens.mockResolvedValue(dedicatedTokens("proxy-1"));
    createGrpcClient
      .mockImplementationOnce(makeFakeClient)
      .mockImplementationOnce(() => {
        throw new Error("direct channel construction failed");
      });

    await expect(createCloudClients("project-1", "secret-1")).rejects.toThrow(
      "direct channel construction failed"
    );

    expect(issuedClients).toHaveLength(1);
    expect(issuedClients[0]?.close).toHaveBeenCalledOnce();
  });

  it("does not add a second client in shared mode", async () => {
    issueImessageTokens.mockResolvedValue({
      expiresIn: 3600,
      token: "shared-token",
      type: "shared",
    });

    const clients = await createCloudClients("project-1", "secret-1");

    expect(clients).toHaveLength(1);
    expect(clients[0]?.resourceClient).toBeUndefined();
    expect(createGrpcClient).toHaveBeenCalledTimes(1);
    expect(await resolveToken(issuedClients[0]?.options.token ?? "")).toBe(
      "shared-token"
    );

    await disposeCloudAuth(clients);
  });

  it("rejects a shared-to-dedicated refresh without corrupting the last good token", async () => {
    issueImessageTokens
      .mockResolvedValueOnce({
        expiresIn: 0,
        token: "shared-1",
        type: "shared",
      })
      .mockResolvedValueOnce(dedicatedTokens("proxy-wrong-mode"))
      .mockResolvedValueOnce({
        expiresIn: 3600,
        token: "shared-2",
        type: "shared",
      });
    const clients = await createCloudClients("project-1", "secret-1");
    const token = issuedClients[0]?.options.token ?? "";

    await expect(resolveToken(token)).rejects.toThrow(
      "changed mode from shared to dedicated"
    );
    await expect(resolveToken(token)).resolves.toBe("shared-2");
    expect(issueImessageTokens).toHaveBeenCalledTimes(3);

    await disposeCloudAuth(clients);
  });

  it("commits a dedicated refresh only after every existing line validates", async () => {
    issueImessageTokens
      .mockResolvedValueOnce(dedicatedTokens("proxy-1", 0))
      .mockResolvedValueOnce({
        ...dedicatedTokens("proxy-invalid"),
        auth: { "instance-1": "direct-invalid" },
      })
      .mockResolvedValueOnce({
        ...dedicatedTokens("proxy-2"),
        auth: {
          "instance-1": "direct-1-refreshed",
          "instance-2": "direct-2-refreshed",
        },
      });
    const clients = await createCloudClients("project-1", "secret-1");
    const proxyToken = issuedClients[0]?.options.token ?? "";

    await expect(resolveToken(proxyToken)).rejects.toThrow(
      MISSING_INSTANCE_AUTH_ERROR
    );
    expect(clients.map((entry) => entry.phone)).toEqual([
      "+15550100",
      "+15550101",
    ]);

    await expect(resolveToken(proxyToken)).resolves.toBe("proxy-2");
    expect(clients.map((entry) => entry.phone)).toEqual([
      "+15550100",
      "+15550101",
    ]);
    await expect(
      resolveToken(issuedClients[1]?.options.token ?? "")
    ).resolves.toBe("direct-1-refreshed");

    await disposeCloudAuth(clients);
  });

  it("rejects line topology or phone changes that require rebuilding streams", async () => {
    issueImessageTokens
      .mockResolvedValueOnce(dedicatedTokens("proxy-1", 0))
      .mockResolvedValueOnce({
        ...dedicatedTokens("proxy-phone-change"),
        numbers: {
          "instance-1": "+15550110",
          "instance-2": "+15550101",
        },
      })
      .mockResolvedValueOnce({
        ...dedicatedTokens("proxy-added-line"),
        auth: {
          "instance-1": "direct-1",
          "instance-2": "direct-2",
          "instance-3": "direct-3",
        },
        numbers: {
          "instance-1": "+15550100",
          "instance-2": "+15550101",
          "instance-3": "+15550102",
        },
      })
      .mockResolvedValueOnce(dedicatedTokens("proxy-2"));
    const clients = await createCloudClients("project-1", "secret-1");
    const proxyToken = issuedClients[0]?.options.token ?? "";

    await expect(resolveToken(proxyToken)).rejects.toThrow(
      "changed the phone for instance instance-1"
    );
    await expect(resolveToken(proxyToken)).rejects.toThrow(
      "changed the dedicated instance set"
    );
    await expect(resolveToken(proxyToken)).resolves.toBe("proxy-2");
    expect(clients.map((entry) => entry.phone)).toEqual([
      "+15550100",
      "+15550101",
    ]);

    await disposeCloudAuth(clients);
  });

  it("does not create an orphan proxy client when no dedicated line resolves", async () => {
    issueImessageTokens.mockResolvedValue({
      ...dedicatedTokens("proxy-1"),
      auth: {},
      numbers: {},
    });

    const clients = await createCloudClients("project-1", "secret-1");

    expect(clients).toEqual([]);
    expect(createGrpcClient).not.toHaveBeenCalled();

    await disposeCloudAuth(clients);
  });

  it("closes a shared dedicated resource client exactly once", async () => {
    issueImessageTokens.mockResolvedValue(dedicatedTokens("proxy-1"));
    const clients = await createCloudClients("project-1", "secret-1");
    const destroyClient = imessage.config({}).__definition.lifecycle
      .destroyClient;

    await destroyClient?.({ client: clients } as never);

    expect(issuedClients).toHaveLength(3);
    for (const issued of issuedClients) {
      expect(issued.close).toHaveBeenCalledTimes(1);
    }
  });
});
