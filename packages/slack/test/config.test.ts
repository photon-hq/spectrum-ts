import { envAwareConfig } from "@spectrum-ts/core/authoring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCloudConfig, configSchema as rawConfigSchema } from "@/types";

// `definePlatform("Slack", ...)` applies the env fallback from the platform id;
// mirror that here so the test exercises the same `SPECTRUM_SLACK_*` resolution.
const configSchema = envAwareConfig("Slack", rawConfigSchema);

const ENDPOINT = "SPECTRUM_SLACK_ENDPOINT";

describe("slack config env fallback", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENDPOINT];
    delete process.env[ENDPOINT];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENDPOINT];
    } else {
      process.env[ENDPOINT] = saved;
    }
  });

  it("reads the direct-mode endpoint from the env var", () => {
    process.env[ENDPOINT] = "https://slack.env.example";
    const config = configSchema.parse({ tokens: { T012ABCDE: "jwt" } });
    expect(isCloudConfig(config)).toBe(false);
    expect(config).toMatchObject({ endpoint: "https://slack.env.example" });
  });

  it("lets an explicit endpoint win over the env var", () => {
    process.env[ENDPOINT] = "https://slack.env.example";
    const config = configSchema.parse({
      endpoint: "https://slack.explicit.example",
      tokens: { T012ABCDE: "jwt" },
    });
    expect(config).toMatchObject({
      endpoint: "https://slack.explicit.example",
    });
  });

  it("does not flip empty config into direct mode via the endpoint env var", () => {
    process.env[ENDPOINT] = "https://slack.env.example";
    const config = configSchema.parse({});
    expect(isCloudConfig(config)).toBe(true);
  });
});
