#!/usr/bin/env bun
/**
 * Generates `dist/manifest.json` — a small public surface describing every
 * provider package in the workspace. Consumed by external tooling (e.g.
 * `create-spectrum-app`) so adding a provider package is enough; downstream
 * scaffolders pick it up automatically.
 *
 * Each entry derives from the provider package's own `package.json#spectrum`
 * field (`{ key, import, label }`), validated against the provider's source:
 * `src/index.ts` must contain `export const <import> = definePlatform(<platformId>)`
 * (the id may be a string literal or resolved through a shared const). That keeps the
 * hand-written metadata from drifting out of sync with the code.
 *
 * The manifest `path` is the provider's npm package name — what a consumer
 * adds to their dependencies and imports from.
 *
 * Runs as part of core's `bun run build`. Pure source reads — no dependency
 * on provider build outputs, so core can build first in the task graph.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface SpectrumField {
  import: string;
  key: string;
  label: string;
}

interface ManifestEntry extends SpectrumField {
  path: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);
const PACKAGES_DIR = dirname(PKG_ROOT);
const OUT_PATH = join(PKG_ROOT, "dist", "manifest.json");

const DEFINE_PLATFORM_RE =
  /^export\s+const\s+(\w+)\s*=\s*definePlatform\(\s*(?:"([^"]+)"|(\w+))/m;

// Providers may pass their platform id as a shared const — the single source
// of truth for routing and runtime tagging — rather than a string literal. When
// the id isn't inline, resolve the const from the provider's own sources.
async function resolvePlatformId(
  srcDir: string,
  constName: string
): Promise<string> {
  const constRe = new RegExp(
    `(?:export\\s+)?const\\s+${constName}\\s*=\\s*"([^"]+)"`
  );
  const files = await readdir(srcDir, { withFileTypes: true });
  for (const file of files) {
    if (!(file.isFile() && file.name.endsWith(".ts"))) {
      continue;
    }
    const match = (await readFile(join(srcDir, file.name), "utf8")).match(
      constRe
    );
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new Error(
    `Provider source references platform-name constant "${constName}" but no \`const ${constName} = "..."\` was found in ${srcDir}.`
  );
}

async function validateAgainstSource(
  pkgDir: string,
  pkgName: string,
  spectrum: SpectrumField
): Promise<void> {
  const srcDir = join(pkgDir, "src");
  const sourcePath = join(srcDir, "index.ts");
  const source = await readFile(sourcePath, "utf8");
  const match = source.match(DEFINE_PLATFORM_RE);
  if (!match) {
    throw new Error(
      `${pkgName}: ${sourcePath} does not match the expected \`export const <name> = definePlatform(<platformId>, ...)\` pattern. If you intentionally renamed the call, update generate-manifest.ts.`
    );
  }
  const [, importName, literalId, idConst] = match;
  if (importName !== spectrum.import) {
    throw new Error(
      `${pkgName}: package.json#spectrum.import is "${spectrum.import}" but src/index.ts exports \`${importName}\`.`
    );
  }
  const platformId =
    literalId ??
    (idConst ? await resolvePlatformId(srcDir, idConst) : undefined);
  if (platformId !== spectrum.label) {
    throw new Error(
      `${pkgName}: package.json#spectrum.label is "${spectrum.label}" but definePlatform uses "${platformId}".`
    );
  }
}

async function buildManifest(): Promise<ManifestEntry[]> {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const manifest: ManifestEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgDir = join(PACKAGES_DIR, entry.name);
    let pkg: {
      name?: string;
      private?: boolean;
      spectrum?: SpectrumField;
    };
    try {
      pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (!pkg.spectrum || pkg.private || !pkg.name) {
      continue;
    }
    const { key, import: importName, label } = pkg.spectrum;
    if (!(key && importName && label)) {
      throw new Error(
        `${pkg.name}: package.json#spectrum must define key, import, and label.`
      );
    }
    await validateAgainstSource(pkgDir, pkg.name, pkg.spectrum);
    manifest.push({ key, import: importName, path: pkg.name, label });
  }

  if (manifest.length === 0) {
    throw new Error(
      `No provider packages with a package.json#spectrum field found under ${PACKAGES_DIR}.`
    );
  }

  // Deterministic order so the file diff is stable across machines / FS orderings.
  manifest.sort((a, b) => a.key.localeCompare(b.key));
  return manifest;
}

const manifest = await buildManifest();
// `mkdir … { recursive: true }` is a no-op when `dist/` already exists (the
// normal case during `bun run build`), and creates it when running the
// script standalone before tsup has populated the directory.
await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `Wrote ${manifest.length} provider entries to ${OUT_PATH}\n`
);
