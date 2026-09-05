import { makeManagedProvider } from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import { MAX_FUSOR_CURSOR_STORE_TIMEOUT_MS } from "@/fusor/core";
import {
  Spectrum,
  type SpectrumInstance,
  type SpectrumOptions,
} from "@/spectrum";

const FUSOR_CURSOR_STORE_TIMEOUT_RE = /fusorCursorStoreTimeoutMs/;

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
          fusorCursorStoreTimeoutMs: 1000,
        },
      });
    } finally {
      await app?.stop();
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    MAX_FUSOR_CURSOR_STORE_TIMEOUT_MS + 1,
  ])("rejects an invalid Fusor cursor store timeout: %s", async (fusorCursorStoreTimeoutMs) => {
    await expect(
      Spectrum({
        providers: [provider()],
        options: { fusorCursorStoreTimeoutMs },
      })
    ).rejects.toThrow(FUSOR_CURSOR_STORE_TIMEOUT_RE);
  });
});
