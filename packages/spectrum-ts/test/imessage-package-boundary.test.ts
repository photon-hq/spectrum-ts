import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
  spectrum?: unknown;
}

const readManifest = async (packageName: string): Promise<PackageManifest> => {
  const path = resolve(
    import.meta.dirname,
    "../..",
    packageName,
    "package.json"
  );
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
};

describe("iMessage package boundary", () => {
  it("keeps local iMessage out of the batteries-included package", async () => {
    const manifest = await readManifest("spectrum-ts");

    expect(manifest.dependencies).toHaveProperty("@spectrum-ts/imessage");
    expect(manifest.dependencies).not.toHaveProperty(
      "@spectrum-ts/imessage-local"
    );
  });

  it("keeps imessage-kit out of the cloud provider", async () => {
    const manifest = await readManifest("imessage");

    expect(manifest.dependencies).not.toHaveProperty("@photon-ai/imessage-kit");
    expect(manifest.dependencies).not.toHaveProperty("better-sqlite3");
  });

  it("installs the Advanced iMessage gRPC transport", async () => {
    const manifest = await readManifest("imessage");

    expect(manifest.dependencies).toMatchObject({
      "@grpc/grpc-js": "^1.14.4",
      "@photon-ai/advanced-imessage": "^2.0.2",
      "nice-grpc": "^2.1.16",
      "nice-grpc-common": "^2.0.3",
    });
  });

  it("installs imessage-kit only with the explicit local provider", async () => {
    const manifest = await readManifest("imessage-local");

    expect(manifest.dependencies).toHaveProperty("@photon-ai/imessage-kit");
    expect(manifest.spectrum).toBeUndefined();
  });
});
