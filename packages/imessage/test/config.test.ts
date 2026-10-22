import { describe, expect, it } from "vitest";
import { configSchema } from "@/types";

describe("iMessage cloud config", () => {
  it("accepts an empty cloud config", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("preserves a heartbeat observer without wrapping it", () => {
    const onHeartbeat = () => undefined;
    expect(configSchema.parse({ onHeartbeat }).onHeartbeat).toBe(onHeartbeat);
  });

  it("rejects a non-function heartbeat observer", () => {
    expect(() => configSchema.parse({ onHeartbeat: true })).toThrow();
  });

  it("rejects the removed local flag", () => {
    expect(() => configSchema.parse({ local: true })).toThrow();
  });
});
