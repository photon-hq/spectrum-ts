import vCard from "vcf";
import z from "zod";
import type { User } from "../types/user";
import { readSchema } from "../utils/io";
import { fromVCard } from "../utils/vcard";
import type { ContentBuilder } from "./types";

const userRefSchema = z.object({
  __platform: z.string(),
  id: z.string(),
});

const nameSchema = z.object({
  formatted: z.string().optional(),
  first: z.string().optional(),
  last: z.string().optional(),
  middle: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

const phoneTypeSchema = z.enum(["mobile", "home", "work", "other"]);
const emailTypeSchema = z.enum(["home", "work", "other"]);
const addressTypeSchema = z.enum(["home", "work", "other"]);

const phoneSchema = z.object({
  value: z.string(),
  type: phoneTypeSchema.optional(),
});

const emailSchema = z.object({
  value: z.string(),
  type: emailTypeSchema.optional(),
});

const addressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  type: addressTypeSchema.optional(),
});

const orgSchema = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  department: z.string().optional(),
});

const photoSchema = z.object({
  mimeType: z.string(),
  read: readSchema,
});

export const contactSchema = z.object({
  type: z.literal("contact"),
  user: userRefSchema.optional(),
  name: nameSchema.optional(),
  phones: z.array(phoneSchema).optional(),
  emails: z.array(emailSchema).optional(),
  addresses: z.array(addressSchema).optional(),
  org: orgSchema.optional(),
  urls: z.array(z.string()).optional(),
  birthday: z.string().optional(),
  note: z.string().optional(),
  photo: photoSchema.optional(),
  raw: z.unknown().optional(),
});

export type Contact = z.infer<typeof contactSchema>;
export type ContactName = z.infer<typeof nameSchema>;
export type ContactPhone = z.infer<typeof phoneSchema>;
export type ContactEmail = z.infer<typeof emailSchema>;
export type ContactAddress = z.infer<typeof addressSchema>;
export type ContactOrg = z.infer<typeof orgSchema>;

export type ContactInput = Omit<Contact, "type">;
export type ContactDetails = Omit<ContactInput, "user">;

export const asContact = (input: ContactInput): Contact =>
  contactSchema.parse({ type: "contact", ...input });

const isUser = (value: unknown): value is User =>
  typeof value === "object" &&
  value !== null &&
  "__platform" in value &&
  "id" in value &&
  typeof (value as User).__platform === "string" &&
  typeof (value as User).id === "string";

export function contact(user: User, details?: ContactDetails): ContentBuilder;
export function contact(input: string | ContactInput | vCard): ContentBuilder;
export function contact(
  input: User | ContactInput | string | vCard,
  details?: ContactDetails
): ContentBuilder {
  return {
    build: async () => {
      if (typeof input === "string") {
        return asContact(fromVCard(input));
      }
      if (input instanceof vCard) {
        return asContact(fromVCard(input.toString()));
      }
      if (isUser(input)) {
        return asContact({
          user: { __platform: input.__platform, id: input.id },
          ...details,
        });
      }
      return asContact(input);
    },
  };
}
