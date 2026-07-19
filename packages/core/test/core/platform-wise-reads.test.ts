import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { baseConfig, makeQueue } from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import z from "zod";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import { UnsupportedError } from "@/utils/errors";

stubCloud();

const MEMBERS = [{ id: "u1", role: "admin" }, { id: "u2" }];
const ICON_BYTES = "png-bytes";
const ICON_MIME = "image/png";

const MEMBERS_UNSUPPORTED =
  /reads_members_bare does not support action "getMembers"/;
const AVATAR_UNSUPPORTED =
  /reads_avatar_bare does not support action "getAvatar"/;
const INSTANCE_MEMBERS_UNSUPPORTED =
  /reads_instance_bare does not support action "getMembers"/;
const INSTANCE_AVATAR_UNSUPPORTED =
  /reads_instance_bare does not support action "getAvatar"/;

// Shared def slots for a minimal provider. The message queue is closed
// immediately — every test gets its space from `space.create`, not the
// inbound stream.
const baseSlots = () => {
  const queue = makeQueue<ProviderMessage<{ id: string }, { id: string }>>();
  queue.close();
  return {
    config: z.object({}),
    lifecycle: {
      createClient: () => Promise.resolve({}),
    },
    user: {
      resolve: ({ input }: { input: { userID: string } }) =>
        Promise.resolve({ id: input.userID }),
    },
    space: {
      create: ({ input }: { input: { users: { id: string }[] } }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "s1" }),
    },
    messages: () => queue.iter,
    send: () => Promise.resolve(undefined),
  };
};

// Provider that implements both platform-wise read actions. `avatar: "none"`
// makes `getAvatar` resolve `undefined` (a group with no icon set).
const makeReadProvider = (name: string, opts?: { avatar?: "none" }) =>
  definePlatform(name, {
    ...baseSlots(),
    actions: {
      getMembers: () => Promise.resolve(MEMBERS),
      getAvatar: () =>
        Promise.resolve(
          opts?.avatar === "none"
            ? undefined
            : { data: Buffer.from(ICON_BYTES), mimeType: ICON_MIME }
        ),
    },
  });

// Provider with no `actions` slot at all — both reads fall back to the
// framework default (`UnsupportedError`).
const makeBareProvider = (name: string) => definePlatform(name, baseSlots());

describe("space.getMembers()", () => {
  it("returns provider records tagged with __platform, extras preserved", async () => {
    const provider = makeReadProvider("reads_members");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const space = await provider(app).space.create("u1");
      const members = await space.getMembers();

      expect(members.map((m) => m.id)).toEqual(["u1", "u2"]);
      expect(members.map((m) => m.__platform)).toEqual([
        "reads_members",
        "reads_members",
      ]);
      expect((members[0] as { role?: string }).role).toBe("admin");
    } finally {
      await app.stop();
    }
  });

  it("throws UnsupportedError when the provider has no implementation", async () => {
    const provider = makeBareProvider("reads_members_bare");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const space = await provider(app).space.create("u1");
      await expect(space.getMembers()).rejects.toThrow(UnsupportedError);
      await expect(space.getMembers()).rejects.toThrow(MEMBERS_UNSUPPORTED);
    } finally {
      await app.stop();
    }
  });
});

describe("space.getAvatar()", () => {
  it("passes the provider's { data, mimeType } through untouched", async () => {
    const provider = makeReadProvider("reads_avatar");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const space = await provider(app).space.create("u1");
      const icon = await space.getAvatar();

      expect(icon?.mimeType).toBe(ICON_MIME);
      expect(Buffer.isBuffer(icon?.data)).toBe(true);
      expect(icon?.data.toString()).toBe(ICON_BYTES);
    } finally {
      await app.stop();
    }
  });

  it("resolves undefined when the provider reports no avatar", async () => {
    const provider = makeReadProvider("reads_avatar_none", { avatar: "none" });
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const space = await provider(app).space.create("u1");
      expect(await space.getAvatar()).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("throws UnsupportedError when the provider has no implementation", async () => {
    const provider = makeBareProvider("reads_avatar_bare");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const space = await provider(app).space.create("u1");
      await expect(space.getAvatar()).rejects.toThrow(AVATAR_UNSUPPORTED);
    } finally {
      await app.stop();
    }
  });
});

describe("platform instance read methods", () => {
  it("im.getMembers/getAvatar resolve the provider records raw", async () => {
    const provider = makeReadProvider("reads_instance");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const space = await instance.space.create("u1");

      const members = await instance.getMembers(space);
      expect(members.map((m) => m.id)).toEqual(["u1", "u2"]);

      const icon = await instance.getAvatar(space);
      expect(icon?.mimeType).toBe(ICON_MIME);
    } finally {
      await app.stop();
    }
  });

  it("defaults to UnsupportedError when the provider omits the actions", async () => {
    // Pins the PLATFORM_WISE_ACTION_KEYS wiring: a key missing from the
    // runtime list would surface as "not a function", not UnsupportedError.
    // The instance default throws synchronously (define.ts wires a plain
    // `() => { throw ... }`) — same contract as `im.getMessage` — so these
    // asserts use `toThrow`, not `rejects`.
    const provider = makeBareProvider("reads_instance_bare");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const space = await instance.space.create("u1");

      expect(() => instance.getMembers(space)).toThrow(
        INSTANCE_MEMBERS_UNSUPPORTED
      );
      expect(() => instance.getAvatar(space)).toThrow(
        INSTANCE_AVATAR_UNSUPPORTED
      );
    } finally {
      await app.stop();
    }
  });
});
