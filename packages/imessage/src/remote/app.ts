import type { AppLayout } from "@spectrum-ts/core";
import {
  asCustomizedMiniApp,
  type CustomizedMiniApp,
} from "../content/customized-mini-app";

/**
 * Fixed identity of Spectrum's own iMessage extension. The universal `app`
 * content renders through this extension, so callers never supply (or even see)
 * these constants — they pass only a URL and the card opens it inside the
 * Spectrum mini app on tap. Callers shipping their *own* extension use the
 * low-level `customizedMiniApp()` instead.
 */
export const SPECTRUM_MINI_APP = {
  appName: "Spectrum",
  extensionBundleId: "codes.photon.Spectrum.MessagesExtension",
  teamId: "P8XT6232SL",
  appStoreId: 6_777_616_651,
} as const;

/**
 * Build the iMessage mini-app card for an `app` content: Spectrum's fixed
 * identity plus the per-message `url`, optional live-rendering hint, and the
 * `layout` already derived from the URL's link metadata.
 */
export const toSpectrumMiniApp = (
  url: string,
  layout: AppLayout,
  live?: boolean
): CustomizedMiniApp =>
  asCustomizedMiniApp({
    ...SPECTRUM_MINI_APP,
    url,
    layout,
    ...(live === undefined ? {} : { live }),
  });
