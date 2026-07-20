import { describe, expect, it } from "vitest";
import { configSchema } from "@/types";

describe("iMessage cloud config", () => {
  it("accepts an empty cloud config", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("rejects the removed local flag", () => {
    expect(() => configSchema.parse({ local: true })).toThrow();
  });

  it("accepts resumable-stream tuning knobs", () => {
    expect(
      configSchema.parse({ bufferLimit: 500, catchUpPageSize: 50 })
    ).toEqual({ bufferLimit: 500, catchUpPageSize: 50 });
  });

  it("rejects non-positive or non-integer tuning values", () => {
    expect(() => configSchema.parse({ bufferLimit: 0 })).toThrow();
    expect(() => configSchema.parse({ catchUpPageSize: -1 })).toThrow();
    expect(() => configSchema.parse({ bufferLimit: 1.5 })).toThrow();
  });
});
