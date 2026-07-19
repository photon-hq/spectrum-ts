import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeManagedProvider,
} from "@spectrum-ts/test-support/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertUniquePlatformNames } from "@/platform/unique-names";
import { Spectrum } from "@/spectrum";

const getProject = stubCloud();

describe("Spectrum() platform name uniqueness", () => {
  beforeEach(() => {
    getProject.mockClear();
  });

  it("rejects duplicate platform names before initialization", async () => {
    const first = makeManagedProvider("imessage").config({});
    const second = makeManagedProvider("imessage").config({});
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
      'Spectrum received multiple providers for platform "imessage". Register exactly one provider per platform.'
    );

    expect(getProject).not.toHaveBeenCalled();
    expect(firstCreateClient).not.toHaveBeenCalled();
    expect(secondCreateClient).not.toHaveBeenCalled();
  });

  it("accepts cloud and local iMessage as separate platforms", () => {
    const cloud = makeManagedProvider("imessage").config({});
    const local = makeManagedProvider("local_imessage").config({});

    expect(() => assertUniquePlatformNames([cloud, local])).not.toThrow();
  });

  it.each([
    "iMessage",
    "WhatsApp Business",
    "whatsapp-business",
    "_telegram",
    "telegram_",
    "telegram__bot",
    "",
  ])("rejects invalid platform id %j", (platformId) => {
    expect(() => makeManagedProvider(platformId)).toThrow(
      `Invalid platform id "${platformId}". Platform ids must use lowercase snake_case (for example, "my_platform").`
    );
  });
});
