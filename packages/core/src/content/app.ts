import z from "zod";
import {
  fetchImage,
  fetchLinkMetadata,
  type LinkMetadata,
} from "../utils/link-metadata";
import type { ContentBuilder } from "./types";

/**
 * Visible layout of an app card. Mirrors Apple's `MSMessageTemplateLayout`
 * (the iMessage mini-app surface) — the iMessage provider renders it natively;
 * other platforms ignore it and fall back to the bare URL. At least one of
 * `caption`, `subcaption`, `trailingCaption`, `trailingSubcaption`, or `image`
 * must be set so the bubble is not empty — `summary` is the fallback text shown
 * on surfaces that cannot render the card and is not a visible slot on its own.
 * `image` and `imageTitle` must be set together; `imageSubtitle` requires
 * `image`.
 */
export const appLayoutSchema = z
  .object({
    caption: z.string().nonempty().optional(),
    subcaption: z.string().nonempty().optional(),
    trailingCaption: z.string().nonempty().optional(),
    trailingSubcaption: z.string().nonempty().optional(),
    image: z.instanceof(Uint8Array).optional(),
    imageTitle: z.string().nonempty().optional(),
    imageSubtitle: z.string().nonempty().optional(),
    summary: z.string().nonempty().optional(),
  })
  .refine(
    (layout) =>
      layout.caption !== undefined ||
      layout.subcaption !== undefined ||
      layout.trailingCaption !== undefined ||
      layout.trailingSubcaption !== undefined ||
      layout.image !== undefined,
    {
      message:
        "layout must set at least one of caption, subcaption, trailingCaption, trailingSubcaption, image",
    }
  )
  .refine(
    (layout) =>
      (layout.image === undefined) === (layout.imageTitle === undefined),
    {
      message: "layout.image and layout.imageTitle must be set together",
      path: ["imageTitle"],
    }
  )
  .refine(
    (layout) =>
      layout.imageSubtitle === undefined || layout.image !== undefined,
    {
      message: "layout.imageSubtitle requires layout.image",
      path: ["imageSubtitle"],
    }
  );

export type AppLayout = z.infer<typeof appLayoutSchema>;

// Both accessors are lazy and async: the layout is parsed from the URL's link
// metadata, so callers who never read it never issue the network request.
const urlAccessor = z.function({ input: [], output: z.promise(z.url()) });
const layoutAccessor = z.function({
  input: [],
  output: z.promise(appLayoutSchema),
});

export const appSchema = z.object({
  type: z.literal("app"),
  url: urlAccessor,
  layout: layoutAccessor,
});

export type App = z.infer<typeof appSchema>;

/**
 * The only thing a caller supplies: the URL. It is itself consumable — pass a
 * string, a promise, or a thunk (sync or async). The thunk form lets the URL be
 * computed at send time (e.g. minting a signed link).
 */
export type AppUrl =
  | string
  | Promise<string>
  | (() => string | Promise<string>);

const memoize = <T>(factory: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= factory();
    return cached;
  };
};

const resolveUrl = (url: AppUrl): (() => Promise<string>) =>
  memoize(async () => (typeof url === "function" ? await url() : await url));

const WWW_PREFIX = /^www\./;

// The bare site host, without a leading `www.` — the fallback "website name"
// when the page exposes no `og:site_name`.
const siteHost = (url: string): string => {
  try {
    return new URL(url).host.replace(WWW_PREFIX, "");
  } catch {
    return url;
  }
};

// The mini-app card's image slot is wire-encoded as JPEG (`imageJpeg`), but
// og:images are overwhelmingly PNG/WebP and there is no in-process transcoder.
// Route the image through the weserv.nl proxy, which re-encodes any source to a
// width-bounded JPEG. The bytes are verified to actually be JPEG before use.
const JPEG_PROXY = "https://wsrv.nl/";
const MAX_IMAGE_WIDTH = 1200;
const toJpegUrl = (imageUrl: string): string =>
  `${JPEG_PROXY}?url=${encodeURIComponent(imageUrl)}&output=jpg&w=${MAX_IMAGE_WIDTH}`;

const isJpeg = (bytes: Uint8Array): boolean =>
  bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

const buildLayout = (
  metadata: LinkMetadata,
  url: string,
  image: Uint8Array | undefined
): AppLayout => {
  // The prominent name is the page title (e.g. "7-Eleven … | DoorDash"),
  // falling back to the site name and then the host so the card is never empty.
  const title = metadata.title ?? metadata.siteName ?? siteHost(url);
  if (image) {
    // `imageTitle` is mandatory whenever `image` is set — use the site name as
    // the banner overlay (falling back to the title when there is no
    // `og:site_name`). `summary` is the fallback shown where the card can't
    // render.
    return appLayoutSchema.parse({
      caption: title,
      subcaption: metadata.summary,
      image,
      imageTitle: metadata.siteName ?? title,
      summary: title,
    });
  }
  return appLayoutSchema.parse({
    caption: title,
    subcaption: metadata.summary,
    summary: title,
  });
};

/**
 * Construct an `app` content value.
 *
 * `url` is stored as a lazy accessor; `layout` is derived from the URL's Open
 * Graph / link metadata (title → caption, og:site_name → image overlay,
 * description → subcaption, og:image → JPEG-transcoded image) using the same
 * machinery as `richlink`. A single metadata fetch is shared and memoized
 * across `url()` / `layout()`; fetch / parse failures resolve to a host-only
 * caption (no throw, no retry).
 */
export const asApp = (url: AppUrl): App => {
  const getUrl = resolveUrl(url);
  const getMetadata = memoize(async () => fetchLinkMetadata(await getUrl()));
  const getLayout = memoize(async (): Promise<AppLayout> => {
    const resolvedUrl = await getUrl();
    const metadata = await getMetadata();
    let image: Uint8Array | undefined;
    if (metadata.image) {
      try {
        const bytes = (await fetchImage(toJpegUrl(metadata.image.url))).data;
        image = isJpeg(bytes) ? bytes : undefined;
      } catch {
        image = undefined;
      }
    }
    return buildLayout(metadata, resolvedUrl, image);
  });

  return appSchema.parse({ type: "app", url: getUrl, layout: getLayout });
};

export function app(url: AppUrl): ContentBuilder {
  return {
    build: async () => asApp(url),
  };
}
