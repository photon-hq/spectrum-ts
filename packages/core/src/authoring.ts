// Provider authoring surface — everything for building a provider.
//
// One stable, semver-respected entry (`@spectrum-ts/core/authoring`) holding
// the building blocks a provider package needs:
//
//   - the `as*` factories that turn a platform's native payloads into `Content`
//   - the content schemas for narrowing/parsing inbound content
//   - the `ProviderMessageRecord` inbound-record type
//   - the generic runtime helpers a provider reaches for when translating
//     between Spectrum and a platform (markdown/audio transforms, the
//     photo-action helpers, the resumable-stream machinery)
//
// In-repo providers reach these through `@spectrum-ts/core/authoring`; external
// packages (e.g. `@photon-ai/linq`) do the same.
//
// Unlike the consumer-facing builders on the main entry (`text()`,
// `attachment()`, …), the factories accept fully-resolved inputs — a custom
// lazy `read()` for authenticated media, a stub target for inbound reactions —
// which is exactly what a provider needs when mapping inbound events.

// Logging & telemetry — the structured logger, level control, and PII helpers
// a provider reaches for so its logs share the SDK's namespaces, severity
// gating, and OTLP pipeline (a single `@photon-ai/otel` instance lives in
// core). Use `createLogger("spectrum.<provider>")` and attach `errorAttrs(err)`
// instead of dumping raw errors.
export {
  createLogger,
  type LogAttrs,
  type LogLevel,
  type PhotonLogger,
  type SanitizeUrlOptions,
  sanitizeEmail,
  sanitizeErrorMessage,
  sanitizePhone,
  sanitizeUrl,
  setLogLevel,
} from "@photon-ai/otel";
// Content factories, schemas, and the inbound-record type (from `content/`).
export { asAttachment } from "./content/attachment";
export { avatarSchema } from "./content/avatar";
export { asContact } from "./content/contact";
export { asCustom } from "./content/custom";
export { messageEffectSchema } from "./content/effect";
export { asGroup, groupSchema } from "./content/group";
export { asMarkdown } from "./content/markdown";
export {
  addMemberSchema,
  leaveSpaceSchema,
  removeMemberSchema,
} from "./content/membership";
export { asPoll, asPollOption } from "./content/poll";
export { asReaction, reactionSchema } from "./content/reaction";
export { asRead } from "./content/read";
export { renameSchema } from "./content/rename";
export { asReply, replySchema } from "./content/reply";
export { asRichlink } from "./content/richlink";
export { asText } from "./content/text";
export { asUnsend } from "./content/unsend";
export { asVoice } from "./content/voice";
export type {
  ProviderMessageRecord,
  ProviderUserRecord,
} from "./platform/types";
// Generic translation helpers (from `utils/`).
export { ensureM4a } from "./utils/audio";
// Config env-var fallback — wrap a config-field schema so an omitted field
// falls back to `process.env[envKey]` (explicit value always wins). `envFor`
// builds the `SPECTRUM_<CHANNEL>_<KEY>` name from its parts.
export { envAwareConfig, envFor, fromEnv } from "./utils/env";
// Outbound-HTTP tracing — wrap a provider's own fetch so its requests get a
// CLIENT span tagged `peer.service`, without ever touching globalThis.fetch.
// Pair `redactUrl` with `sanitizeUrl` to strip secrets from the recorded URL.
export { tracedFetch } from "./utils/instrumented-fetch";
export { renderInlineTokens } from "./utils/markdown";
export {
  buildPhotoAction,
  type PhotoInput,
  photoActionSchema,
} from "./utils/photo-content";
export {
  type CloseableAsyncIterable,
  type ResumableStreamItem,
  resumableOrderedStream,
} from "./utils/resumable-stream";
export { errorAttrs } from "./utils/telemetry";
