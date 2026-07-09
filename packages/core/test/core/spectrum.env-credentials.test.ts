import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { makeManagedProvider } from "@spectrum-ts/test-support/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Spectrum } from "@/spectrum";

const PROJECT_ID = "SPECTRUM_PROJECT_ID";
const PROJECT_SECRET = "SPECTRUM_PROJECT_SECRET";
const ENV_KEYS = [PROJECT_ID, PROJECT_SECRET];

const getProject = stubCloud();

const provider = () => makeManagedProvider("managed").config({});

describe("Spectrum() project credential env fallback", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    getProject.mockClear();
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("resolves project credentials from env when omitted", async () => {
    process.env[PROJECT_ID] = "env-id";
    process.env[PROJECT_SECRET] = "env-secret";

    const app = await Spectrum({ providers: [provider()] });
    expect(getProject).toHaveBeenCalledWith("env-id", "env-secret");
    await app.stop();
  });

  it("lets explicit credentials win over env", async () => {
    process.env[PROJECT_ID] = "env-id";
    process.env[PROJECT_SECRET] = "env-secret";

    const app = await Spectrum({
      projectId: "explicit-id",
      projectSecret: "explicit-secret",
      providers: [provider()],
    });
    expect(getProject).toHaveBeenCalledWith("explicit-id", "explicit-secret");
    await app.stop();
  });

  it("completes a pair from a mix of explicit id and env secret", async () => {
    process.env[PROJECT_SECRET] = "env-secret";

    // The typed overloads require credentials both-or-neither, so a half-typed
    // pair is only reachable at runtime — cast past the overload to exercise the
    // resolved-value invariant directly.
    const options = {
      projectId: "explicit-id",
      providers: [provider()],
    } as unknown as Parameters<typeof Spectrum>[0];

    const app = await Spectrum(options);
    expect(getProject).toHaveBeenCalledWith("explicit-id", "env-secret");
    await app.stop();
  });

  it("does not fetch a project when neither config nor env supplies credentials", async () => {
    const app = await Spectrum({ providers: [provider()] });
    expect(getProject).not.toHaveBeenCalled();
    await app.stop();
  });

  it("rejects a half-supplied credential pair (id via env, no secret)", async () => {
    process.env[PROJECT_ID] = "env-id";

    await expect(Spectrum({ providers: [provider()] })).rejects.toThrow();
  });

  it("treats empty-string env vars as unset (no credentials)", async () => {
    // A CI template that injects the var name without a value leaves it "".
    // That must fall through to the "no credentials" branch, not throw.
    process.env[PROJECT_ID] = "";
    process.env[PROJECT_SECRET] = "";

    const app = await Spectrum({ providers: [provider()] });
    expect(getProject).not.toHaveBeenCalled();
    await app.stop();
  });
});
