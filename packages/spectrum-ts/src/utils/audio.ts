import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

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

const FFMPEG_MISSING_MESSAGE =
  "voice content: input is not m4a/aac and ffmpeg is unavailable. Install `ffmpeg-static` or ensure `ffmpeg` is on PATH.";

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
    return;
  }
};

export const resolveFfmpegPath = async (): Promise<string> => {
  if (cachedFfmpegPath) {
    return cachedFfmpegPath;
  }
  cachedFfmpegPath = (await tryStaticBinary()) ?? "ffmpeg";
  return cachedFfmpegPath;
};

const collectStream = (stream: Readable | null): Promise<string> => {
  if (!stream) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
};

const isMissingBinaryError = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

const runFfmpeg = (
  ffmpegPath: string,
  args: string[]
): Promise<{ code: number; stderr: string }> => {
  const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = collectStream(proc.stderr);
  const exit = new Promise<number>((resolve, reject) => {
    proc.on("error", (err) =>
      reject(
        isMissingBinaryError(err) ? new Error(FFMPEG_MISSING_MESSAGE) : err
      )
    );
    proc.on("exit", (code) => resolve(code ?? -1));
  });
  return Promise.all([exit, stderr]).then(([code, text]) => ({
    code,
    stderr: text,
  }));
};

const DURATION_PATTERN = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

const parseDuration = (stderr: string): number | undefined => {
  const match = stderr.match(DURATION_PATTERN);
  if (!match) {
    return;
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
    const { code, stderr } = await runFfmpeg(ffmpeg, [
      "-y",
      "-i",
      inPath,
      "-f",
      "ipod",
      "-c:a",
      "aac",
      outPath,
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg conversion failed (exit ${code}): ${stderr}`);
    }
    const out = await readFile(outPath);
    return { buffer: out, duration: parseDuration(stderr) };
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
