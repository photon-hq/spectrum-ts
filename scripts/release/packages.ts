#!/usr/bin/env bun
/**
 * Single source of truth for "what do we publish" — shared by bump-version,
 * verify-versions, prepare-packages, publish, and check-artifacts.
 *
 * Publishable = every workspace package under packages/ without
 * `"private": true` (excludes examples/ and @spectrum-ts/test-support).
 * Topologically ordered: the core (`spectrum-ts`) publishes first so the
 * providers' `spectrum-ts@^N` peer range is satisfiable the moment each
 * provider lands on the registry; providers follow alphabetically.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// The runtime publishes first (every provider peer-deps it); the `spectrum-ts`
// metapackage publishes last (it depends on the runtime and all providers).
export const CORE_NAME = "@spectrum-ts/core";
export const META_NAME = "spectrum-ts";

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  spectrum?: { key: string; import: string; label: string };
  version: string;
  [key: string]: unknown;
}

export interface PublishablePackage {
  dir: string;
  json: PackageJson;
  path: string;
}

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

export async function publishablePackages(): Promise<PublishablePackage[]> {
  const packagesDir = join(REPO_ROOT, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const pkgs: PublishablePackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(packagesDir, entry.name, "package.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      // A workspace directory without a package.json is legitimately skipped;
      // any other read error (permissions, etc.) is not.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new Error(`failed to read ${path}: ${(error as Error).message}`);
    }
    let json: PackageJson;
    try {
      json = JSON.parse(raw) as PackageJson;
    } catch (error) {
      // A malformed manifest must fail loudly — silently skipping it would
      // drop the package from a release.
      throw new Error(`failed to parse ${path}: ${(error as Error).message}`);
    }
    if (json.private === true || !json.name) {
      continue;
    }
    pkgs.push({ dir: join(packagesDir, entry.name), path, json });
  }
  if (!pkgs.some((p) => p.json.name === CORE_NAME)) {
    throw new Error(`core package "${CORE_NAME}" not found under packages/`);
  }
  if (!pkgs.some((p) => p.json.name === META_NAME)) {
    throw new Error(`metapackage "${META_NAME}" not found under packages/`);
  }
  const rank = (name: string): number => {
    if (name === CORE_NAME) {
      return 0; // runtime first
    }
    if (name === META_NAME) {
      return 2; // metapackage last
    }
    return 1; // providers in the middle
  };
  pkgs.sort((a, b) => {
    const byRank = rank(a.json.name) - rank(b.json.name);
    return byRank === 0 ? a.json.name.localeCompare(b.json.name) : byRank;
  });
  return pkgs;
}
