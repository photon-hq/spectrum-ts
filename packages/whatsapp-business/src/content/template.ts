import type { Content, ContentBuilder } from "@spectrum-ts/core";
import z from "zod";

/**
 * WhatsApp-only template message content. Lives entirely under the WhatsApp
 * Business provider — never enters the universal `Content` discriminated
 * union. The framework recognizes it via the generic content-level platform
 * contract: `__platform: "WhatsApp Business"` lets
 * `findUnsupportedPlatformContent` warn-and-skip when a different platform
 * receives it.
 *
 * Templates are the only message type Meta accepts outside the 24-hour
 * customer-service window (free-form sends fail with error 131047), so this
 * is the escape hatch for re-engaging stale conversations. v1 covers the
 * common case: a pre-approved template addressed by name + language, with
 * positional `{{1}}..{{n}}` body text parameters. Header/button components
 * can be added later without breaking this shape.
 */
export const whatsappTemplateSchema = z.object({
  type: z.literal("whatsapp-template"),
  __platform: z.literal("WhatsApp Business"),
  // Name of an approved template in the WhatsApp Business account.
  name: z.string().min(1),
  // Template language/locale code as approved, e.g. "en_US".
  languageCode: z.string().min(1),
  // Positional body text parameters; count must match the template's
  // variables (Meta rejects mismatches with error 132000).
  bodyParams: z.array(z.string()).optional(),
});

export type WhatsAppTemplate = z.infer<typeof whatsappTemplateSchema>;
export type WhatsAppTemplateInput = Omit<
  WhatsAppTemplate,
  "type" | "__platform"
>;

export const isWhatsAppTemplate = (value: unknown): value is WhatsAppTemplate =>
  whatsappTemplateSchema.safeParse(value).success;

export const asWhatsAppTemplate = (
  input: WhatsAppTemplateInput
): WhatsAppTemplate =>
  whatsappTemplateSchema.parse({
    type: "whatsapp-template",
    __platform: "WhatsApp Business",
    ...input,
  });

export function whatsappTemplate(input: WhatsAppTemplateInput): ContentBuilder {
  return {
    build: async () => asWhatsAppTemplate(input) as unknown as Content,
  };
}
