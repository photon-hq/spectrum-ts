import { makeManagedProvider } from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import {
  Spectrum,
  type SpectrumInstance,
  type SpectrumOptions,
} from "@/spectrum";

const provider = () => makeManagedProvider("managed").config({});

describe("Spectrum() runtime options", () => {
  it.each([
    { load: async () => undefined },
    { save: async () => undefined },
    { load: "not callable", save: async () => undefined },
    { load: async () => undefined, save: "not callable" },
  ])("rejects an invalid Fusor cursor store: %o", async (fusorCursorStore) => {
    await expect(
      Spectrum({
        providers: [provider()],
        options: {
          fusorCursorStore:
            fusorCursorStore as unknown as SpectrumOptions["fusorCursorStore"],
        },
      })
    ).rejects.toThrow();
  });

  it("accepts a Fusor cursor store with callable load and save methods", async () => {
    let app: SpectrumInstance | undefined;
    try {
      app = await Spectrum({
        providers: [provider()],
        options: {
          fusorCursorStore: {
            load: async () => undefined,
            save: async () => undefined,
          },
        },
      });
    } finally {
      await app?.stop();
    }
  });
});
