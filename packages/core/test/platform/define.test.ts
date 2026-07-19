import { describe, expect, it } from "vitest";
import z from "zod";
import { definePlatform } from "@/index";

const minimalDefinition = {
  config: z.object({}),
  lifecycle: {
    createClient: () => Promise.resolve({}),
  },
  user: {
    resolve: () => Promise.resolve({ id: "user" }),
  },
  space: {
    create: () => Promise.resolve({ id: "space" }),
  },
  async *messages() {},
  send: () => Promise.resolve(undefined),
};

describe("definePlatform platform ids", () => {
  it.each([
    "imessage",
    "local_imessage",
    "platform2",
  ])("accepts valid lowercase snake_case id %j", (platformId) => {
    expect(() => definePlatform(platformId, minimalDefinition)).not.toThrow();
  });

  it.each([
    ["uppercase", "iMessage"],
    ["hyphenated", "local-imessage"],
    ["leading underscore", "_imessage"],
    ["trailing underscore", "imessage_"],
    ["consecutive underscores", "local__imessage"],
  ])("rejects %s id %j", (_case, platformId) => {
    expect(() => definePlatform(platformId, minimalDefinition)).toThrowError(
      `Invalid platform id "${platformId}". Platform ids must use lowercase snake_case (for example, "my_platform").`
    );
  });
});
