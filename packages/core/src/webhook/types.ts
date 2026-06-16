import z from "zod";

/**
 * Wire schemas for the **native Spectrum webhook**
 * (https://photon.codes/docs/webhooks).
 *
 * Unlike the fusor webhook — which relays a raw provider request inside a
 * protobuf envelope — the native webhook delivers Spectrum's own message model
 * already normalized to slim JSON (methods and byte payloads stripped), signed
 * with an HMAC. These schemas validate the fields the deserializer depends on
 * while **preserving** unknown/extra fields (`z.looseObject`), so additive
 * changes — new platform-specific space fields, future content arms — never
 * break an older SDK. Content is discriminated by hand in `deserialize.ts`
 * rather than here, so an unknown content `type` survives parsing instead of
 * throwing.
 */

export const slimSenderSchema = z.looseObject({
  id: z.string(),
  platform: z.string().optional(),
});

export const slimSpaceSchema = z.looseObject({
  id: z.string(),
  platform: z.string().optional(),
});

export const slimContentSchema = z.looseObject({
  type: z.string(),
});

/** A slim reference to another message — e.g. a reaction's `target`. */
export const slimMessageRefSchema = z.looseObject({
  id: z.string(),
  platform: z.string().optional(),
  timestamp: z.string().optional(),
  sender: slimSenderSchema.optional(),
  contentPreview: z.string().optional(),
});

export const slimMessageSchema = z.looseObject({
  id: z.string(),
  platform: z.string().optional(),
  // Webhooks are inbound-only; `direction` is left loose (not a `"inbound"`
  // literal) so a future direction value cannot fail an older SDK's parse.
  direction: z.string().optional(),
  timestamp: z.string().optional(),
  sender: slimSenderSchema.optional(),
  space: slimSpaceSchema,
  content: slimContentSchema,
});

export const slimEnvelopeSchema = z.looseObject({
  event: z.string(),
  space: slimSpaceSchema.optional(),
  message: slimMessageSchema,
});

export type SlimSender = z.infer<typeof slimSenderSchema>;
export type SlimSpace = z.infer<typeof slimSpaceSchema>;
export type SlimContent = z.infer<typeof slimContentSchema>;
export type SlimMessageRef = z.infer<typeof slimMessageRefSchema>;
export type SlimMessage = z.infer<typeof slimMessageSchema>;
export type SlimEnvelope = z.infer<typeof slimEnvelopeSchema>;
