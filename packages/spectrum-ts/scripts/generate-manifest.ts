#!/usr/bin/env bun
/**
 * Generates `dist/manifest.json` — a small public surface describing every
 * provider in `src/providers/`. Consumed by external tooling (e.g.
 * `create-spectrum-app`) so adding a provider here is enough; downstream
 * scaffolders pick it up automatically.
 *
 * Each entry derives from the provider's own source: the directory name is
 * the `key`, the exported `const` is the `import`, and the first argument to
 * `definePlatform(...)` is the `label`. No hand-curated list to drift out
 * of sync.
 *
 * Run as part of `bun run build`, after `tsup`. Standalone-safe — creates
 * `dist/` if missing — but a manifest entry whose compiled artifact
 * (`dist/providers/<key>/index.js`) is absent will fail the script, since
 * shipping such an entry would point consumers at code that doesn't exist.
 */

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ManifestEntry {
  import: string;
  key: string;
  label: string;
  path: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);
const PROVIDERS_DIR = join(PKG_ROOT, "src", "providers");
const DIST_PROVIDERS_DIR = join(PKG_ROOT, "dist", "providers");
const OUT_PATH = join(PKG_ROOT, "dist", "manifest.json");

const DEFINE_PLATFORM_RE =
  /^export\s+const\s+(\w+)\s*=\s*definePlatform\(\s*"([^"]+)"/m;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function buildManifest(): Promise<ManifestEntry[]> {
  const entries = await readdir(PROVIDERS_DIR, { withFileTypes: true });
  const manifest: ManifestEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const key = entry.name;
    const sourcePath = join(PROVIDERS_DIR, key, "index.ts");
    const source = await readFile(sourcePath, "utf8");
    const match = source.match(DEFINE_PLATFORM_RE);
    if (!match) {
      throw new Error(
        `Provider "${key}" at ${sourcePath} does not match the expected \`export const <name> = definePlatform("<label>", ...)\` pattern. If you intentionally renamed the call, update generate-manifest.ts.`
      );
    }
    const [, importName, label] = match;
    if (!(importName && label)) {
      throw new Error(`Failed to parse provider "${key}"`);
    }

    // Guard against the manifest declaring a provider that tsup didn't
    // actually compile (e.g. someone added src/providers/foo/ without also
    // adding it to tsup.config.ts's entry list). Shipping such an entry
    // would have downstream consumers fail to resolve the import path.
    const compiled = join(DIST_PROVIDERS_DIR, key, "index.js");
    if (!(await fileExists(compiled))) {
      throw new Error(
        `Provider "${key}" has source at ${sourcePath} but no compiled output at ${compiled}. Add it to tsup.config.ts's entry list (or run \`bun run build\` first if invoking generate:manifest standalone).`
      );
    }

    manifest.push({
      key,
      import: importName,
      path: `spectrum-ts/providers/${key}`,
      label,
    });
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
