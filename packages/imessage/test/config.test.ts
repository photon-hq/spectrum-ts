import { describe, expect, it } from "vitest";
import { configSchema } from "@/types";

describe("iMessage cloud config", () => {
  it("accepts an empty cloud config", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("rejects the removed local flag", () => {
    expect(() => configSchema.parse({ local: true })).toThrow();
  });

  it("accepts explicit HTTP clients with optional gateway routing", () => {
    const client = {
      address: "imessage-http.photon.codes",
      phone: "+15550100",
      server: "instance-one",
      token: "token-one",
    };

    expect(configSchema.parse({ clients: client })).toEqual({
      clients: client,
    });
  });
});
