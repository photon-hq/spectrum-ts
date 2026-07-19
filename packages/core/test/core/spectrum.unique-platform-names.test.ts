import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeManagedProvider,
} from "@spectrum-ts/test-support/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Spectrum } from "@/spectrum";

const getProject = stubCloud();

describe("Spectrum() platform name uniqueness", () => {
  beforeEach(() => {
    getProject.mockClear();
  });

  it("rejects duplicate platform names before initialization", async () => {
    const first = makeManagedProvider("iMessage").config({});
    const second = makeManagedProvider("iMessage").config({});
    const firstCreateClient = vi.spyOn(
      first.__definition.lifecycle,
      "createClient"
    );
    const secondCreateClient = vi.spyOn(
      second.__definition.lifecycle,
      "createClient"
    );

    await expect(
      Spectrum({
        ...baseConfig,
        providers: [first, second],
      })
    ).rejects.toThrow(
      'Spectrum received multiple providers for platform "iMessage". Register exactly one provider per platform.'
    );

    expect(getProject).not.toHaveBeenCalled();
    expect(firstCreateClient).not.toHaveBeenCalled();
    expect(secondCreateClient).not.toHaveBeenCalled();
  });
});
