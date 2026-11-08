import type {
  AdvancedIMessage,
  BackgroundPreset as SdkBackgroundPreset,
} from "@photon-ai/advanced-imessage/grpc";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type BackgroundPreset, isBackground } from "@/content/background";
import { background, imessage } from "@/index";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const def = imessage.config({}).__definition;

const ctx = {
  config: {} as never,
  store: undefined as never,
};

describe("background preset", () => {
  it("lists exactly the SDK's preset names", () => {
    expectTypeOf<BackgroundPreset>().toEqualTypeOf<SdkBackgroundPreset>();
  });

  it("builds a preset background signal", async () => {
    const content = await background({ preset: "skyDusk" }).build();

    expect(content).toEqual({
      type: "background",
      __platform: "imessage",
      __fireAndForget: true,
      action: { kind: "preset", preset: "skyDusk" },
    });
    expect(isBackground(content)).toBe(true);
  });

  it("routes the preset to chats.setBackground and is fire-and-forget", async () => {
    const setBackground = vi.fn((_chat: string, _background: unknown) =>
      Promise.resolve()
    );
    const client: RemoteClient[] = [
      {
        phone: SHARED_PHONE,
        client: { chats: { setBackground } } as unknown as AdvancedIMessage,
      },
    ];

    const result = await def.send({
      ...ctx,
      client,
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: await background({ preset: "colorMango" }).build(),
    });

    expect(result).toBeUndefined();
    expect(setBackground).toHaveBeenCalledWith("any;-;+15550123", "colorMango");
  });
});
