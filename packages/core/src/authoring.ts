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

// Content factories, schemas, and the inbound-record type (from `content/`).
export { asAttachment } from "./content/attachment";
export { asContact } from "./content/contact";
export { asCustom } from "./content/custom";
export { messageEffectSchema } from "./content/effect";
export { asGroup, groupSchema } from "./content/group";
export { asMarkdown } from "./content/markdown";
export { asPoll, asPollOption } from "./content/poll";
export { asReaction, reactionSchema } from "./content/reaction";
export { asRead } from "./content/read";
export { asRichlink } from "./content/richlink";
export { asText } from "./content/text";
export { asVoice } from "./content/voice";
export type { ProviderMessageRecord } from "./platform/types";

// Generic translation helpers (from `utils/`).
export { ensureM4a } from "./utils/audio";
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
