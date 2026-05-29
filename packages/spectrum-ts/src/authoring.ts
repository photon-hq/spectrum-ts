// Provider-authoring surface.
//
// The `as*` factories and `ProviderMessageRecord` type used to turn a
// platform's native payloads into Spectrum `Content` / inbound records. In-repo
// providers (slack, whatsapp, imessage) reach these through relative imports;
// external provider packages (e.g. `@photon-ai/linq`) import them from
// `spectrum-ts/authoring`.
//
// Unlike the consumer-facing builders exported from the main entry (`text()`,
// `attachment()`, …), these factories accept fully-resolved inputs — including
// a custom lazy `read()` for authenticated media downloads and a stub target
// for inbound reactions — which is exactly what a provider needs when mapping
// inbound events.

export { asAttachment } from "./content/attachment";
export { asContact } from "./content/contact";
export { asCustom } from "./content/custom";
export { asGroup } from "./content/group";
export { asPoll, asPollOption } from "./content/poll";
export { asReaction } from "./content/reaction";
export { asRichlink } from "./content/richlink";
export { asText } from "./content/text";
export { asVoice } from "./content/voice";
export type { ProviderMessageRecord } from "./platform/types";
