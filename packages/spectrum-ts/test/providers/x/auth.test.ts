import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import {
  createCloudAuth,
  getCloudAuth,
  X_AUTH_STORE_KEY,
} from "@/providers/x/auth";
import { cloud } from "@/utils/cloud";
import { createStore } from "@/utils/store";

const credentials = {
  auth: { "42": "cloud-access-token" },
  accounts: { "acc-1": { xUserId: "42" } },
  consumerSecret: "cloud-consumer-secret",
  expiresIn: 900,
};

describe("x createCloudAuth", () => {
  beforeEach(() => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue(credentials);
  });

  afterEach(() => {
    mock.restore();
  });

  it("stores auth on the platform store and resolves tokens", async () => {
    const store = createStore();
    const auth = await createCloudAuth({
      projectId: "proj",
      projectSecret: "secret",
      store,
    });

    expect(store.get(X_AUTH_STORE_KEY)).toBe(auth);
    await expect(auth.getAccessToken()).resolves.toBe("cloud-access-token");
    await expect(auth.getConsumerSecret()).resolves.toBe(
      "cloud-consumer-secret"
    );
    expect(auth.getXUserId()).toBe("42");
  });

  it("honors a pinned xUserId", async () => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue({
      ...credentials,
      auth: {
        "42": "token-a",
        "77": "token-b",
      },
      accounts: {
        a: { xUserId: "42" },
        b: { xUserId: "77" },
      },
    });

    const store = createStore();
    const auth = await createCloudAuth({
      projectId: "proj",
      projectSecret: "secret",
      pinnedXUserId: "77",
      store,
    });

    expect(auth.getXUserId()).toBe("77");
    await expect(auth.getAccessToken()).resolves.toBe("token-b");
  });

  it("throws when no accounts are linked", async () => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue({
      auth: {},
      accounts: {},
      consumerSecret: "secret",
      expiresIn: 900,
    });

    const store = createStore();
    await expect(
      createCloudAuth({
        projectId: "proj",
        projectSecret: "secret",
        store,
      })
    ).rejects.toThrow("No X accounts linked");
  });

  it("throws when pinned xUserId is not linked", async () => {
    const store = createStore();
    await expect(
      createCloudAuth({
        projectId: "proj",
        projectSecret: "secret",
        pinnedXUserId: "999",
        store,
      })
    ).rejects.toThrow('Configured xUserId "999"');
  });

  it("throws when multiple accounts are linked without xUserId pin", async () => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue({
      auth: {
        "42": "token-a",
        "77": "token-b",
      },
      accounts: {
        a: { xUserId: "42" },
        b: { xUserId: "77" },
      },
      consumerSecret: "cloud-consumer-secret",
      expiresIn: 900,
    });

    const store = createStore();
    await expect(
      createCloudAuth({
        projectId: "proj",
        projectSecret: "secret",
        store,
      })
    ).rejects.toThrow("Multiple X accounts linked");
  });

  it("dispose clears the store entry and timers", async () => {
    const store = createStore();
    const auth = await createCloudAuth({
      projectId: "proj",
      projectSecret: "secret",
      store,
    });

    auth.dispose();
    expect(getCloudAuth(store)).toBeUndefined();
    await expect(auth.getAccessToken()).rejects.toThrow("disposed");
  });
});
