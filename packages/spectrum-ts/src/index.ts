// Batteries-included entry for the `spectrum-ts` metapackage.
//
// Re-exports the full runtime (`@spectrum-ts/core`) so consumers who want
// everything in one install can `import { Spectrum, text, … } from "spectrum-ts"`
// exactly as before. The provider packages are reached through the
// `spectrum-ts/providers/*` subpaths (or installed individually as
// `@spectrum-ts/<platform>`).
export * from "@spectrum-ts/core";
