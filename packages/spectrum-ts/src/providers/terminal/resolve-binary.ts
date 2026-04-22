// Resolves the tuichat binary on disk, downloading from GitHub Releases on
// first use. Cache layout: <platform-cache>/tuichat/v<version>/tuichat-<target><ext>.
//
// Version precedence: TUICHAT_VERSION env → the value pinned in DEFAULT_VERSION.
// Verification: fetch SHA256SUMS from the same release, check against download.
//
// No external deps — stdlib only.

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Pinned default; bump on each certified tuichat release.
export const DEFAULT_VERSION = "0.1.2";

const REPO = "photon-hq/tuichat";

type Target =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64";

function targetSuffix(): Target {
  const key = `${process.platform}-${process.arch}`;
  const map: Record<string, Target> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "win32-x64": "windows-x64",
  };
  const t = map[key];
  if (!t) {
    throw new Error(`tuichat: unsupported platform/arch: ${key}`);
  }
  return t;
}

function cacheDir(version: string): string {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "tuichat", `v${version}`);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "tuichat", `v${version}`);
  }
  const xdg = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdg, "tuichat", `v${version}`);
}

const LINE_SPLIT = /\r?\n/;
const CHECKSUM_LINE = /^([a-f0-9]{64})\s+\*?(\S+)$/;

function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(LINE_SPLIT)) {
    const m = line.match(CHECKSUM_LINE);
    if (m?.[1] && m[2]) {
      out[m[2]] = m[1];
    }
  }
  return out;
}

export interface ResolveOptions {
  /** Set to true to force re-download even if cached. */
  force?: boolean;
  /** Override the version (default: TUICHAT_VERSION env or DEFAULT_VERSION). */
  version?: string;
}

export async function resolveTuichatBinary(
  options: ResolveOptions = {}
): Promise<string> {
  // Dev/local override: skip download, use a local binary path directly.
  const override = process.env.TUICHAT_BINARY;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`tuichat: TUICHAT_BINARY=${override} does not exist`);
    }
    return override;
  }

  const version =
    options.version ?? process.env.TUICHAT_VERSION ?? DEFAULT_VERSION;
  const target = targetSuffix();
  const ext = target.startsWith("windows") ? ".exe" : "";
  const filename = `tuichat-${target}${ext}`;
  const dir = cacheDir(version);
  const path = join(dir, filename);

  if (!options.force && existsSync(path)) {
    return path;
  }

  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const [sumsRes, binRes] = await Promise.all([
    fetch(`${base}/SHA256SUMS`),
    fetch(`${base}/${filename}`),
  ]);
  if (!sumsRes.ok) {
    throw new Error(
      `tuichat: failed to fetch SHA256SUMS (v${version}): HTTP ${sumsRes.status}`
    );
  }
  if (!binRes.ok) {
    throw new Error(
      `tuichat: failed to fetch ${filename} (v${version}): HTTP ${binRes.status}`
    );
  }
  const expected = parseChecksums(await sumsRes.text())[filename];
  if (!expected) {
    throw new Error(
      `tuichat: no checksum for ${filename} in SHA256SUMS (v${version})`
    );
  }
  const bytes = Buffer.from(await binRes.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `tuichat: checksum mismatch for ${filename} (expected ${expected}, got ${actual})`
    );
  }
  mkdirSync(dir, { recursive: true });
  // Write to a unique temp path in the same directory, chmod, then atomically
  // rename into place. Avoids torn writes when multiple processes resolve the
  // same version concurrently or when a process crashes mid-download.
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, bytes);
    if (process.platform !== "win32") {
      chmodSync(tmpPath, 0o755);
    }
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Temp may not exist if writeFileSync was what failed — ignore.
    }
    throw err;
  }
  return path;
}
