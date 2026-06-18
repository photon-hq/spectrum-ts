import ogs from "open-graph-scraper";
import { type FetchedBytes, fetchUrlBytes } from "./io";

export interface LinkMetadata {
  image?: { mimeType?: string; url: string };
  summary?: string;
  title?: string;
}

export type FetchedImage = FetchedBytes;

const DEFAULT_TIMEOUT_MS = 5000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15 spectrum-ts/richlink";

const normaliseImageUrl = (raw: string, base: string): string | undefined => {
  try {
    return new URL(raw, base).toString();
  } catch {
    return;
  }
};

const cleanString = (v: string | undefined): string | undefined => {
  if (typeof v !== "string") {
    return;
  }
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const fetchLinkMetadata = async (url: string): Promise<LinkMetadata> => {
  try {
    const result = await ogs({
      url,
      timeout: DEFAULT_TIMEOUT_MS,
      fetchOptions: { headers: { "User-Agent": USER_AGENT } },
    });
    if (result.error) {
      return {};
    }
    const {
      ogTitle,
      ogDescription,
      ogImage,
      twitterTitle,
      twitterDescription,
      twitterImage,
    } = result.result;

    const title = cleanString(ogTitle) ?? cleanString(twitterTitle);
    const summary =
      cleanString(ogDescription) ?? cleanString(twitterDescription);

    const imageCandidate = ogImage?.[0] ?? twitterImage?.[0];
    const resolved = imageCandidate
      ? normaliseImageUrl(imageCandidate.url, url)
      : undefined;
    const image =
      imageCandidate && resolved
        ? {
            url: resolved,
            mimeType:
              "type" in imageCandidate &&
              typeof imageCandidate.type === "string"
                ? imageCandidate.type
                : undefined,
          }
        : undefined;

    return { title, summary, image };
  } catch {
    return {};
  }
};

export const fetchImage = (url: string): Promise<FetchedImage> =>
  fetchUrlBytes(new URL(url), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headers: { "User-Agent": USER_AGENT },
  });
