// Compat shim — `spectrum-ts/providers` (the v4 aggregate entrypoint).
//
// Faithful to v4 semantics: importing the aggregate requires ALL official
// provider packages to be installed (in v4 they were all bundled here).
// Prefer importing from the individual `@photon-ai/spectrum-provider-*`
// packages — or the per-provider `spectrum-ts/providers/*` shims — so you
// only install the platforms you use.
export { imessage } from "@photon-ai/spectrum-provider-imessage";
export { slack } from "@photon-ai/spectrum-provider-slack";
export { telegram } from "@photon-ai/spectrum-provider-telegram";
export { terminal } from "@photon-ai/spectrum-provider-terminal";
export { whatsappBusiness } from "@photon-ai/spectrum-provider-whatsapp-business";
