#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type PackageJson, publishablePackages, REPO_ROOT } from "./packages";

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STAGING_SUFFIX = /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const { RELEASE_VERSION, RELEASE_SUFFIX, RELEASE_CHANNEL, PACK_DESTINATION } =
  process.env;
if (
  !(
    RELEASE_VERSION &&
    STABLE.test(RELEASE_VERSION) &&
    PACK_DESTINATION &&
    ((RELEASE_CHANNEL === "staging" &&
      STAGING_SUFFIX.test(RELEASE_SUFFIX ?? "")) ||
      (RELEASE_CHANNEL === "production" && RELEASE_SUFFIX === ""))
  )
) {
  throw new Error(
    "pack.ts needs RELEASE_VERSION=X.Y.Z, PACK_DESTINATION, and RELEASE_CHANNEL=staging with RELEASE_SUFFIX=-staging.<run>.<attempt> or production with an empty suffix"
  );
}

const version = `${RELEASE_VERSION}${RELEASE_SUFFIX}`;
const destination = resolve(PACK_DESTINATION);
const pkgs = await publishablePackages();
const paths = [
  ...pkgs.map((pkg) => pkg.path),
  join(REPO_ROOT, "packages/core/src/build-env.ts"),
];
const originals = await Promise.all(paths.map((path) => readFile(path)));
const env = { ...process.env, SPECTRUM_PUBLISH: "1" };
const run = (command: string, args: string[], cwd = REPO_ROOT): void => {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
};

await mkdir(destination, { recursive: true });
try {
  run("bun", ["scripts/release/bump-version.ts", version]);
  run("bun", ["scripts/release/verify-versions.ts", version]);
  run("bun", ["run", "build", "--force"]);
  run("bun", ["scripts/release/check-artifacts.ts"]);
  run("bun", ["scripts/release/prepare-packages.ts"]);
  for (const pkg of pkgs) {
    const cleaned = join(pkg.dir, ".clean-publish-tmp");
    try {
      run(
        "bunx",
        [
          "clean-publish",
          "--without-publish",
          "--temp-dir",
          ".clean-publish-tmp",
          "--package-manager",
          "npm",
        ],
        pkg.dir
      );
      const packed = JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            destination,
          ],
          { cwd: cleaned, env, encoding: "utf8" }
        )
      ) as { filename: string }[];
      const entry = packed[0];
      if (packed.length !== 1 || !entry) {
        throw new Error(`${pkg.json.name}: npm pack must produce one archive`);
      }
      const archive = JSON.parse(
        execFileSync(
          "tar",
          ["-xOzf", join(destination, entry.filename), "package/package.json"],
          { encoding: "utf8" }
        )
      ) as PackageJson;
      const expected = JSON.parse(
        await readFile(pkg.path, "utf8")
      ) as PackageJson;
      if (archive.name !== pkg.json.name || archive.version !== version) {
        throw new Error(
          `${pkg.json.name}: archive holds ${archive.name}@${archive.version}, expected ${version}`
        );
      }
      if (archive.devDependencies || archive.scripts) {
        throw new Error(
          `${pkg.json.name}: archive contains development fields`
        );
      }
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ] as const) {
        if (!isDeepStrictEqual(archive[field], expected[field])) {
          throw new Error(
            `${pkg.json.name}: archive ${field} differ from the versioned manifest`
          );
        }
      }
      console.log(
        `✓ archive ${archive.name}@${archive.version}: identity and dependencies verified`
      );
    } finally {
      await rm(cleaned, { recursive: true, force: true });
    }
  }
  console.log(`✓ packed ${pkgs.length} packages at ${version}`);
} finally {
  await Promise.all(
    paths.map((path, index) => writeFile(path, originals[index] as Buffer))
  );
}
