import { describe, expect, it } from "vitest";
import { configSchema } from "@/types";

describe("iMessage cloud config", () => {
  it("accepts an empty cloud config", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("rejects the removed local flag", () => {
    expect(() => configSchema.parse({ local: true })).toThrow();
  });

  it("accepts an explicit client without a server id", () => {
    const entry = { address: "a.example:443", token: "t", phone: "+15550100" };
    expect(configSchema.parse({ clients: entry })).toEqual({ clients: entry });
  });

  it("accepts an explicit client with a dedicated server id", () => {
    const entry = {
      address: "a.example:443",
      phone: "+15550100",
      server: "instance-a",
      token: "t",
    };
    expect(configSchema.parse({ clients: [entry] })).toEqual({
      clients: [entry],
    });
  });
});
