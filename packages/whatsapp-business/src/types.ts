import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import type { SchemaMessage } from "@spectrum-ts/core";
import z from "zod";

// Direct-mode credential VALUES fall back to `SPECTRUM_WHATSAPP_BUSINESS_*` env
// vars (explicit config wins), applied automatically by `definePlatform` from
// the platform id. `mode` is the discriminator and is NOT env-backed (a literal,
// not a string leaf), so a direct mode is always chosen explicitly in code —
// an empty `whatsappBusiness.config()` resolves to cloud mode, never a guessed
// direct mode with half-filled credentials.

const APP_SECRET_REQUIRED =
  "WhatsApp Business `mode: 'inbound'` requires `appSecret` (it verifies inbound webhook signatures). Provide it, or use `mode: 'outbound-only'` for send-only.";

// Inbound direct mode: opens the live event stream, which needs `appSecret` to
// authenticate/verify inbound webhooks. All three credentials are mandatory —
// the previous optional-`appSecret`-substituted-`""` shape let inbound subscribe
// start silently unauthenticated, which is exactly what this prevents.
const inboundConfig = z.strictObject({
  mode: z.literal("inbound"),
  accessToken: z.string().min(1),
  appSecret: z.string({ error: APP_SECRET_REQUIRED }).min(1),
  phoneNumberId: z.string().min(1),
});

// Outbound-only direct mode: send-only. It carries no `appSecret` and never
// opens an inbound subscribe (see `isOutboundOnly` / the provider `messages`).
const outboundOnlyConfig = z.strictObject({
  mode: z.literal("outbound-only"),
  accessToken: z.string().min(1),
  phoneNumberId: z.string().min(1),
});

// Cloud mode: no direct credentials — Spectrum Cloud issues per-line tokens.
const cloudConfig = z.strictObject({});

// A discriminated union on `mode`: inbound requires `appSecret`, outbound-only
// forbids it, cloud takes neither. A partial or ambiguous config — credentials
// without a `mode`, or inbound without `appSecret` — matches no branch and
// fails fast at parse (before any stream starts), so it can never silently
// resolve to a broken inbound mode.
export const configSchema = z.union([
  inboundConfig,
  outboundOnlyConfig,
  cloudConfig,
]);

export type WhatsAppConfig = z.infer<typeof configSchema>;
export type WhatsAppClients = WhatsAppClient[];

// Cloud mode is the only branch without a `mode` discriminator.
export const isCloudConfig = (
  config: WhatsAppConfig
): config is z.infer<typeof cloudConfig> => !("mode" in config);

// Direct outbound-only mode never opens an inbound subscribe — it has no
// `appSecret` to authenticate one — so its message stream stays empty.
export const isOutboundOnly = (config: WhatsAppConfig): boolean =>
  !isCloudConfig(config) && config.mode === "outbound-only";

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
});

export type WhatsAppMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
>;
