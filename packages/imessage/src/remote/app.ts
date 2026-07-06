import type { MiniAppMessage } from "@photon-ai/advanced-imessage";
import type { AppLayout } from "@spectrum-ts/core";

/**
 * Server-managed Spectrum mini-app card for universal `app` content. Callers
 * supply only a URL; the advanced iMessage server owns the Spectrum extension
 * identity and wraps the URL for the mini-app host. Callers shipping their own
 * extension use the low-level `customizedMiniApp()` instead.
 */
export type SpectrumMiniApp = MiniAppMessage;

const previewTitle = (url: string, layout: AppLayout): string =>
  layout.caption ?? layout.imageTitle ?? layout.summary ?? new URL(url).host;

/**
 * Build the server-managed iMessage mini-app card for an `app` content: the
 * per-message `url` plus the static preview already derived from link metadata.
 */
export const toSpectrumMiniApp = (
  url: string,
  layout: AppLayout
): SpectrumMiniApp => ({
  url,
  preview: {
    title: previewTitle(url, layout),
    subtitle: layout.imageSubtitle,
    body: layout.subcaption,
    imageJpeg: layout.image,
    caption: layout.caption,
    footer: layout.trailingCaption,
    detail: layout.trailingSubcaption,
    summary: layout.summary ?? layout.caption ?? layout.imageTitle,
  },
});
