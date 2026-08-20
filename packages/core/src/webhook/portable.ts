// Portable native-webhook primitives — the `@spectrum-ts/core/webhook` entry.
//
// Everything on this surface is runtime-agnostic: signature verification runs
// on Web Crypto and the slim wire schemas are plain zod, with no Node builtins
// anywhere in the import graph. It is what an HTTP adapter needs to verify and
// parse a native Spectrum webhook delivery on runtimes where the Node-flavored
// `Spectrum()` runtime can't live — Convex's V8 isolate, Cloudflare Workers,
// Deno Deploy — and it is the single source of truth those adapters share with
// `spectrum.webhook()` for the wire format.
//
// Deliberately NOT here: `webhook/deserialize.ts`. It materializes full
// `Content` objects and pulls the Node-only content builders (`node:fs`,
// `node:crypto`), so turning a slim envelope into a live `[space, message]`
// pair stays a `Spectrum()` concern.

export type {
  SlimContent,
  SlimEnvelope,
  SlimMessage,
  SlimMessageRef,
  SlimSender,
  SlimSpace,
} from "./types";
export {
  slimContentSchema,
  slimEnvelopeSchema,
  slimMessageRefSchema,
  slimMessageSchema,
  slimSenderSchema,
  slimSpaceSchema,
} from "./types";
export {
  type VerifyInput,
  type VerifyResult,
  verifySpectrumSignature,
} from "./verify";
