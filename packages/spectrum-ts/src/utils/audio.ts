import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const M4A_BRANDS: ReadonlySet<string> = new Set([
  "M4A ",
  "M4B ",
  "M4P ",
  "mp42",
  "mp41",
  "isom",
  "iso2",
]);

const M4A_MIME_TYPES: ReadonlySet<string> = new Set([
  "audio/mp4",
  "audio/mp4a-latm",
  "audio/x-m4a",
  "audio/aac",
  "audio/aacp",
]);

export const isM4a = (buffer: Buffer): boolean => {
  if (buffer.length < 12) {
    return false;
  }
  if (buffer.toString("ascii", 4, 8) !== "ftyp") {
    return false;
  }
  return M4A_BRANDS.has(buffer.toString("ascii", 8, 12));
};

const isM4aMimeType = (mimeType: string): boolean =>
  M4A_MIME_TYPES.has(mimeType.toLowerCase());

let cachedFfmpegPath: string | undefined;

const tryStaticBinary = async (): Promise<string | undefined> => {
  try {
    const mod = await import("ffmpeg-static");
    return mod.default ?? undefined;
  } catch {
    return undefined;
  }
};

const tryPathLookup = async (): Promise<string | undefined> => {
  try {
    const proc = spawn(["which", "ffmpeg"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      return undefined;
    }
    const path = output.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
};

export const resolveFfmpegPath = async (): Promise<string> => {
  if (cachedFfmpegPath) {
    return cachedFfmpegPath;
  }
  const resolved = (await tryStaticBinary()) ?? (await tryPathLookup());
  if (!resolved) {
    throw new Error(
      "voice content: input is not m4a/aac and ffmpeg is unavailable. Install `ffmpeg-static` or ensure `ffmpeg` is on PATH."
    );
  }
  cachedFfmpegPath = resolved;
  return resolved;
};

const DURATION_PATTERN = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

const parseDuration = (stderr: string): number | undefined => {
  const match = stderr.match(DURATION_PATTERN);
  if (!match) {
    return undefined;
  }
  const [, hh, mm, ss, frac] = match;
  const seconds =
    Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(`0.${frac ?? 0}`);
  return Number.isFinite(seconds) ? seconds : undefined;
};

const transcodeToM4a = async (
  buffer: Buffer
): Promise<{ buffer: Buffer; duration?: number }> => {
  const ffmpeg = await resolveFfmpegPath();
  const dir = await mkdtemp(join(tmpdir(), "spectrum-voice-"));
  const inPath = join(dir, "in");
  const outPath = join(dir, "out.m4a");
  try {
    await writeFile(inPath, buffer);
    const proc = spawn(
      [ffmpeg, "-y", "-i", inPath, "-f", "ipod", "-c:a", "aac", outPath],
      { stdout: "ignore", stderr: "pipe" }
    );
    const stderrText = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`ffmpeg conversion failed (exit ${code}): ${stderrText}`);
    }
    const out = await readFile(outPath);
    return { buffer: out, duration: parseDuration(stderrText) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

export const ensureM4a = async (
  buffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; duration?: number }> => {
  if (isM4aMimeType(mimeType) || isM4a(buffer)) {
    return { buffer };
  }
  return transcodeToM4a(buffer);
};
