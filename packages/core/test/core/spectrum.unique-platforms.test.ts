import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { makeManagedProvider } from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import { assertUniquePlatformNames } from "@/platform/unique-names";
import { Spectrum } from "@/spectrum";

stubCloud();

const DUPLICATE_IMESSAGE = /duplicate platform name.*"iMessage".*2×/;
const DUPLICATE_DUP = /"dup" \(2×\)/;
const DUPLICATE_OTHER = /"other" \(3×\)/;
const DUPLICATE_SHARED = /duplicate platform name.*"shared"/;

describe("assertUniquePlatformNames", () => {
  it("accepts distinct platform names", () => {
    expect(() =>
      assertUniquePlatformNames([
        makeManagedProvider("alpha").config({}),
        makeManagedProvider("beta").config({}),
      ])
    ).not.toThrow();
  });

  it("rejects a duplicated definePlatform name", () => {
    expect(() =>
      assertUniquePlatformNames([
        makeManagedProvider("iMessage").config({}),
        makeManagedProvider("iMessage").config({}),
      ])
    ).toThrow(DUPLICATE_IMESSAGE);
  });

  it("lists every colliding name when several collide", () => {
    const providers = [
      makeManagedProvider("dup").config({}),
      makeManagedProvider("ok").config({}),
      makeManagedProvider("dup").config({}),
      makeManagedProvider("other").config({}),
      makeManagedProvider("other").config({}),
      makeManagedProvider("other").config({}),
    ];

    expect(() => assertUniquePlatformNames(providers)).toThrow(DUPLICATE_DUP);
    expect(() => assertUniquePlatformNames(providers)).toThrow(DUPLICATE_OTHER);
  });
});

describe("Spectrum() unique platform names", () => {
  it("fails closed when two providers share a definePlatform name", async () => {
    await expect(
      Spectrum({
        providers: [
          makeManagedProvider("shared").config({}),
          makeManagedProvider("shared").config({}),
        ],
      })
    ).rejects.toThrow(DUPLICATE_SHARED);
  });

  it("registers providers with distinct names side by side", async () => {
    const app = await Spectrum({
      platforms: [
        makeManagedProvider("iMessage").config({}),
        makeManagedProvider("iMessage (local mode)").config({}),
      ],
    });

    expect(app.__providers).toHaveLength(2);
    expect(app.__internal.platforms.has("iMessage")).toBe(true);
    expect(app.__internal.platforms.has("iMessage (local mode)")).toBe(true);
    await app.stop();
  });
});
