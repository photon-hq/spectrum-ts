import { describe, expect, it } from "vitest";
import { configSchema } from "@/types";

describe("iMessage cloud config", () => {
  it("accepts an empty cloud config", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("rejects the removed local flag", () => {
    expect(() => configSchema.parse({ local: true })).toThrow();
  });
});
