import ogs from "open-graph-scraper";

export interface LinkMetadata {
  image?: { mimeType?: string; url: string };
  summary?: string;
  title?: string;
}

export interface FetchedImage {
  data: Buffer;
  mimeType?: string;
}

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

export const fetchImage = async (url: string): Promise<FetchedImage> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`image fetch ${url} returned ${res.status}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") ?? undefined;
    return { data, mimeType };
  } finally {
    clearTimeout(timer);
  }
};
