// Provider-plumbing surface — `spectrum-ts/internal`.
//
// Internals that first-party provider packages (`@photon-ai/spectrum-provider-*`)
// need but that don't belong on the consumer-facing main entry: raw content
// schemas for inbound validation, markdown/audio/photo helpers for outbound
// translation, and the resumable-stream machinery.
//
// SEMVER-EXEMPT: this entry exists for provider packages released in lockstep
// with the core. Anything here may change or disappear in a minor release —
// application code should import from `spectrum-ts` or `spectrum-ts/authoring`
// instead.

export { messageEffectSchema } from "./content/effect";
export { groupSchema } from "./content/group";
export { reactionSchema } from "./content/reaction";
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
