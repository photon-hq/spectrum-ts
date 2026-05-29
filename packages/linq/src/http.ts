const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Download bytes from a (presigned, publicly accessible) LinQ URL. Used for
 * inbound media reads and as the client's `downloadMedia`.
 */
export const fetchBytes = async (
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Buffer> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(
      `LinQ media download failed: ${res.status} ${res.statusText}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
};
