// Compat shim — `spectrum-ts/providers` (the v4 aggregate entrypoint).
//
// Faithful to v4 semantics: importing the aggregate requires ALL official
// provider packages to be installed (in v4 they were all bundled here).
// Prefer importing from the individual `@spectrum-ts/*`
// packages — or the per-provider `spectrum-ts/providers/*` shims — so you
// only install the platforms you use.
export { imessage } from "@spectrum-ts/imessage";
export { slack } from "@spectrum-ts/slack";
export { telegram } from "@spectrum-ts/telegram";
export { terminal } from "@spectrum-ts/terminal";
export { whatsappBusiness } from "@spectrum-ts/whatsapp-business";
