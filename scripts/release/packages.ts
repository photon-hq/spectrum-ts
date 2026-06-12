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

export const CORE_NAME = "spectrum-ts";

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
    let json: PackageJson;
    try {
      json = JSON.parse(await readFile(path, "utf8")) as PackageJson;
    } catch {
      continue;
    }
    if (json.private === true || !json.name) {
      continue;
    }
    pkgs.push({ dir: join(packagesDir, entry.name), path, json });
  }
  if (!pkgs.some((p) => p.json.name === CORE_NAME)) {
    throw new Error(`core package "${CORE_NAME}" not found under packages/`);
  }
  pkgs.sort((a, b) => {
    if (a.json.name === CORE_NAME) {
      return -1;
    }
    if (b.json.name === CORE_NAME) {
      return 1;
    }
    return a.json.name.localeCompare(b.json.name);
  });
  return pkgs;
}
