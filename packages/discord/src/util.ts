import type { DiscordSendSpec } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;

// Discord file uploads are `multipart/form-data`: a `payload_json` part carries
// the JSON body and each file is a `files[n]` part. photon's typed `createMessage`
// only models the JSON body, so raw-byte uploads go through the low-level
// `client.post` with this serializer (modeled on Telegram's adapter). fetch sets
// the multipart boundary itself, so the default JSON `Content-Type` is dropped
// (`null`) at the call site.
export const toFormData = (spec: DiscordSendSpec): FormData => {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(spec.payload));
  spec.files?.forEach((file, index) => {
    form.append(
      `files[${index}]`,
      new File([new Uint8Array(file.bytes)], file.filename, {
        type: file.contentType,
      }),
      file.filename
    );
  });
  return form;
};

/**
 * Fetch attachment bytes. Discord CDN URLs are pre-signed and public, so the
 * download is an unauthenticated `fetch` — the one place the adapter reaches
 * Discord outside the photon client.
 */
export const downloadAttachment = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `Discord media download failed: ${res.status} ${res.statusText}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
};
