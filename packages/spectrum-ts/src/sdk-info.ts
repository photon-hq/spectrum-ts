/**
 * Static SDK identity constants. Useful for log lines, telemetry tags,
 * and diagnostic dumps when multiple SDK versions or processes might be
 * running side by side and the operator needs to confirm which build
 * produced a particular event.
 *
 * Kept deliberately minimal — anything that varies per build (the
 * `version`) should be sourced from `package.json` at the call site
 * rather than baked in here, to avoid drift between this file and the
 * published package metadata.
 */

/** The published npm package name for this SDK. */
export const SDK_NAME = "spectrum-ts" as const;

/** The canonical homepage / source URL for this SDK. */
export const SDK_HOMEPAGE = "https://github.com/photon-hq/spectrum-ts" as const;
