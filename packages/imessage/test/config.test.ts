import { describe, expect, it } from "vitest";
import { configSchema } from "@/types";

describe("iMessage cloud config", () => {
  it("accepts an empty cloud config", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("rejects the removed local flag", () => {
    expect(() => configSchema.parse({ local: true })).toThrow();
  });

  it("accepts the resumable-stream buffer limit", () => {
    expect(configSchema.parse({ bufferLimit: 500 })).toEqual({
      bufferLimit: 500,
    });
  });

  it("rejects catch-up page sizing unsupported by the gRPC transport", () => {
    expect(() => configSchema.parse({ catchUpPageSize: 50 })).toThrow();
  });

  it("rejects non-positive or non-integer buffer limits", () => {
    expect(() => configSchema.parse({ bufferLimit: 0 })).toThrow();
    expect(() => configSchema.parse({ bufferLimit: -1 })).toThrow();
    expect(() => configSchema.parse({ bufferLimit: 1.5 })).toThrow();
  });
});
