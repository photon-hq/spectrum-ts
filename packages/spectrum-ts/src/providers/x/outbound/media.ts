import type { Attachment } from "../../../content/attachment";
import { UnsupportedError } from "../../../utils/errors";
import { X_PLATFORM, type XEffectiveConfig } from "../config";
import { extractXErrorMessage } from "./client";

type UploadConfig = Pick<XEffectiveConfig, "accessToken" | "baseUrl">;

/** Recommended chunk size for the APPEND step (1 MB). */
const CHUNK_SIZE = 1024 * 1024;
const MILLIS_PER_SECOND = 1000;
/** Fallback poll interval when the API omits `check_after_secs`. */
const DEFAULT_STATUS_DELAY_SECS = 1;
/** Cap STATUS polls so a stuck/failed upload can't loop forever. */
const MAX_STATUS_POLLS = 60;

interface ProcessingInfo {
  check_after_secs?: number;
  error?: { message?: string };
  state?: string;
}

interface MediaUploadData {
  id?: string;
  media_id_string?: string;
  processing_info?: ProcessingInfo;
}

interface MediaUploadResponse {
  data?: MediaUploadData;
  // Legacy v1.1 shape puts these at the top level.
  media_id_string?: string;
  processing_info?: ProcessingInfo;
}

/**
 * Map an attachment MIME type to the X DM media category. DMs accept images,
 * animated GIFs and video; anything else is rejected before any upload starts.
 */
const resolveMediaCategory = (mimeType: string): string => {
  if (mimeType === "image/gif") {
    return "dm_gif";
  }
  if (mimeType.startsWith("image/")) {
    return "dm_image";
  }
  if (mimeType.startsWith("video/")) {
    return "dm_video";
  }
  throw UnsupportedError.content(
    "attachment",
    X_PLATFORM,
    `MIME type "${mimeType}" cannot be sent as a DM attachment (only images, GIFs and video are supported).`
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * POST/GET the chunked media endpoint with Bearer auth and a multipart or query
 * payload. Unlike `xApiFetch`, this never forces a JSON Content-Type so the
 * runtime can set the multipart boundary for `FormData` bodies.
 *
 * Env escape hatches: `X_MEDIA_UPLOAD_URL` overrides the upload endpoint (e.g.
 * to point at a different host/proxy when X's tier gating blocks the default),
 * and `X_MEDIA_DEBUG` logs the raw request/response to stderr for diagnosis.
 */
const mediaFetch = async (
  config: UploadConfig,
  init: { body?: FormData; method: "GET" | "POST"; query?: string }
): Promise<MediaUploadResponse> => {
  const base =
    process.env.X_MEDIA_UPLOAD_URL ?? `${config.baseUrl}/2/media/upload`;
  const url = `${base}${init.query ? `?${init.query}` : ""}`;
  const response = await fetch(url, {
    method: init.method,
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: init.body,
  });
  const raw = await response.text();
  if (process.env.X_MEDIA_DEBUG) {
    process.stderr.write(
      `[x-media] ${init.method} ${url} -> ${response.status}\n` +
        `[x-media] resp-headers: ${JSON.stringify(Object.fromEntries(response.headers))}\n` +
        `[x-media] resp-body: ${raw}\n`
    );
  }
  let payload: unknown = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message = extractXErrorMessage(response.status, payload);
    const detail = raw ? ` — ${raw.slice(0, 500)}` : "";
    if (response.status === 403) {
      throw new Error(
        `${message}${detail} (X rejected the media upload. Ensure the token has the "media.write" scope, and note that POST /2/media/upload is gated by API access tier — the Free tier returns a generic "Forbidden" and OAuth 1.0a is required for the v1.1 endpoint. A Basic+ tier project is typically needed for OAuth 2.0 media upload.)`
      );
    }
    throw new Error(`${message}${detail}`);
  }
  return payload as MediaUploadResponse;
};

const readMediaId = (response: MediaUploadResponse): string | undefined =>
  response.data?.id ??
  response.data?.media_id_string ??
  response.media_id_string;

const readProcessingInfo = (
  response: MediaUploadResponse
): ProcessingInfo | undefined =>
  response.data?.processing_info ?? response.processing_info;

const init = async (
  config: UploadConfig,
  totalBytes: number,
  mediaType: string,
  mediaCategory: string
): Promise<string> => {
  const form = new FormData();
  form.set("command", "INIT");
  form.set("total_bytes", String(totalBytes));
  form.set("media_type", mediaType);
  form.set("media_category", mediaCategory);
  const response = await mediaFetch(config, { method: "POST", body: form });
  const mediaId = readMediaId(response);
  if (!mediaId) {
    throw new Error("X media upload INIT response is missing a media id");
  }
  return mediaId;
};

const append = async (
  config: UploadConfig,
  mediaId: string,
  bytes: Buffer
): Promise<void> => {
  let segmentIndex = 0;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    const form = new FormData();
    form.set("command", "APPEND");
    form.set("media_id", mediaId);
    form.set("segment_index", String(segmentIndex));
    form.set("media", new Blob([chunk]));
    await mediaFetch(config, { method: "POST", body: form });
    segmentIndex += 1;
  }
};

const finalize = async (
  config: UploadConfig,
  mediaId: string
): Promise<MediaUploadResponse> => {
  const form = new FormData();
  form.set("command", "FINALIZE");
  form.set("media_id", mediaId);
  return await mediaFetch(config, { method: "POST", body: form });
};

const isTerminalState = (state: string | undefined): boolean =>
  state === "succeeded" || state === "failed";

/**
 * Poll `command=STATUS` until processing finishes. Only invoked when FINALIZE
 * reports asynchronous processing (video/GIF). Throws on a `failed` state or
 * when the poll budget is exhausted.
 */
const waitForProcessing = async (
  config: UploadConfig,
  mediaId: string,
  initial: ProcessingInfo
): Promise<void> => {
  let info: ProcessingInfo | undefined = initial;
  for (let poll = 0; poll < MAX_STATUS_POLLS; poll += 1) {
    if (!info || isTerminalState(info.state)) {
      break;
    }
    const delaySecs = info.check_after_secs ?? DEFAULT_STATUS_DELAY_SECS;
    await sleep(delaySecs * MILLIS_PER_SECOND);
    const response = await mediaFetch(config, {
      method: "GET",
      query: `command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
    });
    info = readProcessingInfo(response);
  }

  if (info?.state === "failed") {
    throw new Error(
      `X media processing failed: ${info.error?.message ?? "unknown error"}`
    );
  }
  if (info && info.state !== "succeeded") {
    throw new Error("X media processing did not complete in time");
  }
};

/**
 * Upload an attachment to X via the chunked media endpoint and return its
 * `media_id` for use in a DM's `attachments`. Runs INIT → APPEND(s) → FINALIZE,
 * then polls STATUS when the media requires asynchronous processing.
 */
export const uploadDmMedia = async (
  config: UploadConfig,
  attachment: Attachment
): Promise<string> => {
  const mediaCategory = resolveMediaCategory(attachment.mimeType);
  const bytes = await attachment.read();
  const mediaId = await init(
    config,
    bytes.length,
    attachment.mimeType,
    mediaCategory
  );
  await append(config, mediaId, bytes);
  const finalized = await finalize(config, mediaId);
  const processing = readProcessingInfo(finalized);
  if (processing) {
    // Resolves immediately for a terminal state (and throws on `failed`),
    // otherwise polls STATUS until processing finishes.
    await waitForProcessing(config, mediaId, processing);
  }
  return mediaId;
};
