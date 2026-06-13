// Compat shim — `spectrum-ts/providers/telegram` (the v4 import path).
//
// The provider lives in `@spectrum-ts/telegram` since v5; this
// re-export keeps v4 imports working once that package is installed. A pure
// `export *` is deliberate: it is the one shape that fails loudly everywhere
// when the package is missing — hard build error in esbuild/bun/webpack/Vite,
// `ERR_MODULE_NOT_FOUND` naming the package at startup under plain Node/Bun,
// and a type error at the consumer's import even under `skipLibCheck`.
// Mixing in any named export would silently degrade those failures to `any`.
export * from "@spectrum-ts/telegram";
