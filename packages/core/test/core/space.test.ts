import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeManagedProvider,
  makeSchemaProvider,
} from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import { Spectrum } from "@/spectrum";

stubCloud();

const NEEDS_HOOK_ERROR =
  /space-get-needs-hook.*cannot construct a space from an id alone[\s\S]*space\.get/;

describe("space.create", () => {
  it("resolves a single string user through user.resolve and builds a full space", async () => {
    const provider = makeManagedProvider("space-create-single");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const space = await instance.space.create("u42");
      expect(space.id).toBe("u42");
      expect(space.__platform).toBe("space-create-single");
      expect(typeof space.send).toBe("function");
    } finally {
      await app.stop();
    }
  });

  it("accepts mixed string/PlatformUser arrays and resolves every entry", async () => {
    const provider = makeSchemaProvider("space-create-mixed");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const resolved = await instance.user("b");
      const space = await instance.space.create(["a", resolved], {
        extra: "custom",
      });
      expect(space.id).toBe("a+b");
      expect(space.extra).toBe("custom");
    } finally {
      await app.stop();
    }
  });

  it("validates params against the provider params schema", async () => {
    const provider = makeSchemaProvider("space-create-params");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const badParams = { extra: 123 } as unknown as { extra: string };
      await expect(instance.space.create(["a"], badParams)).rejects.toThrow();
    } finally {
      await app.stop();
    }
  });

  it("validates the created space against the space schema", async () => {
    const provider = makeSchemaProvider("space-create-schema");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const space = await instance.space.create(["a"], { extra: "kept" });
      // Schema fields are surfaced as typed extras on the built space.
      expect(space.extra).toBe("kept");
    } finally {
      await app.stop();
    }
  });
});

describe("space.get", () => {
  it("defaults to { id } when the provider has no get hook and no schema", async () => {
    const provider = makeManagedProvider("space-get-default");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const space = await instance.space.get("s9");
      expect(space.id).toBe("s9");
      expect(space.__platform).toBe("space-get-default");
      expect(typeof space.send).toBe("function");
    } finally {
      await app.stop();
    }
  });

  it("hydrates platform fields through the provider get hook", async () => {
    const provider = makeSchemaProvider("space-get-hook", { withGet: true });
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      const space = await instance.space.get("g1", { extra: "hydrated-x" });
      expect(space.id).toBe("g1");
      expect(space.extra).toBe("hydrated-x");
    } finally {
      await app.stop();
    }
  });

  it("fails loudly when the schema needs fields the default { id } cannot supply", async () => {
    const provider = makeSchemaProvider("space-get-needs-hook");
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const instance = provider(app);
      await expect(
        instance.space.get("g1", { extra: "ignored" })
      ).rejects.toThrow(NEEDS_HOOK_ERROR);
    } finally {
      await app.stop();
    }
  });
});
