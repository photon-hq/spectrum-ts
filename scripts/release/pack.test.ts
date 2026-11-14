import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./packages";

const bun = execFileSync("bun", ["--print", "process.execPath"], {
  encoding: "utf8",
}).trim();
const environment = {
  ...process.env,
  RELEASE_VERSION: "13.0.0",
  RELEASE_CHANNEL: "production",
  RELEASE_SUFFIX: "",
  PACK_DESTINATION: "/unused",
};

it.each([
  { RELEASE_VERSION: "13.0.0-beta.1" },
  { RELEASE_VERSION: "013.0.0" },
  { RELEASE_CHANNEL: "beta" },
  { RELEASE_SUFFIX: "-staging.1.1" },
  { RELEASE_CHANNEL: "staging", RELEASE_SUFFIX: "" },
  { RELEASE_CHANNEL: "staging", RELEASE_SUFFIX: "-staging.01.1" },
  { PACK_DESTINATION: "" },
])("rejects invalid Buildspace pack coordinates: %j", (override) => {
  const result = spawnSync(bun, ["scripts/release/pack.ts"], {
    cwd: REPO_ROOT,
    env: { ...environment, ...override },
    encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("pack.ts needs RELEASE_VERSION=X.Y.Z");
});

it.each([
  ["production", "", "^13.0.0"],
  ["staging", "-staging.42.1", "13.0.0-staging.42.1"],
])("rewrites %s dependencies and restores tracked files when a build fails", async (channel, suffix, peer) => {
  const root = await mkdtemp(join(tmpdir(), "spectrum-pack-"));
  try {
    await mkdir(join(root, "scripts/release"), { recursive: true });
    await mkdir(join(root, "bin"));
    for (const script of [
      "pack.ts",
      "packages.ts",
      "bump-version.ts",
      "verify-versions.ts",
    ]) {
      await copyFile(
        join(REPO_ROOT, "scripts/release", script),
        join(root, "scripts/release", script)
      );
    }
    const originals = new Map<string, string>();
    for (const [dir, json] of [
      ["core", { name: "@spectrum-ts/core" }],
      [
        "provider",
        {
          name: "@spectrum-ts/provider",
          peerDependencies: { "@spectrum-ts/core": "^12.0.0" },
        },
      ],
      [
        "spectrum-ts",
        {
          name: "spectrum-ts",
          dependencies: {
            "@spectrum-ts/core": "12.16.0",
            "@spectrum-ts/provider": "12.16.0",
          },
        },
      ],
    ] as const) {
      await mkdir(join(root, "packages", dir), { recursive: true });
      const path = join(root, "packages", dir, "package.json");
      const raw = `${JSON.stringify({ ...json, version: "12.16.0" }, null, 2)}\n`;
      await writeFile(path, raw);
      originals.set(path, raw);
    }
    await mkdir(join(root, "packages/core/src"));
    const buildEnv = join(root, "packages/core/src/build-env.ts");
    await writeFile(buildEnv, "original build environment\n");
    originals.set(buildEnv, "original build environment\n");
    const shim = join(root, "bin/bun");
    await writeFile(
      shim,
      `#!/bin/sh
if [ "$1" = run ]; then
  cp packages/provider/package.json "$TEST_ROOT/provider.json"
  cp packages/spectrum-ts/package.json "$TEST_ROOT/meta.json"
  printf 'changed build environment\\n' > packages/core/src/build-env.ts
  exit 23
fi
exec "$REAL_BUN" "$@"
`
    );
    await chmod(shim, 0o755);
    const result = spawnSync(bun, [join(root, "scripts/release/pack.ts")], {
      cwd: root,
      env: {
        ...environment,
        RELEASE_CHANNEL: channel,
        RELEASE_SUFFIX: suffix,
        PACK_DESTINATION: join(root, "archives"),
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        REAL_BUN: bun,
        TEST_ROOT: root,
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("3 packages verified");
    const provider = JSON.parse(
      await readFile(join(root, "provider.json"), "utf8")
    );
    const meta = JSON.parse(await readFile(join(root, "meta.json"), "utf8"));
    expect(provider.version).toBe(`13.0.0${suffix}`);
    expect(provider.peerDependencies["@spectrum-ts/core"]).toBe(peer);
    expect(Object.values(meta.dependencies)).toEqual([
      `13.0.0${suffix}`,
      `13.0.0${suffix}`,
    ]);
    for (const [path, original] of originals) {
      expect(await readFile(path, "utf8")).toBe(original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
