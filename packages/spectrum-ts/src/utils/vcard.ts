import vCard from "vcf";
import type {
  Contact,
  ContactAddress,
  ContactEmail,
  ContactInput,
  ContactName,
  ContactOrg,
  ContactPhone,
} from "../content/contact";

type VCardProperty = vCard.Property & {
  type?: string | string[];
  encoding?: string | string[];
};

const asPropertyArray = (
  prop: vCard.Property | vCard.Property[] | undefined
): VCardProperty[] => {
  if (!prop) {
    return [];
  }
  const arr = Array.isArray(prop) ? prop : [prop];
  return arr as VCardProperty[];
};

const propString = (
  prop: vCard.Property | vCard.Property[] | undefined
): string | undefined => {
  const [first] = asPropertyArray(prop);
  const value = first?.valueOf().trim();
  return value ? value : undefined;
};

const paramTypes = (prop: VCardProperty): string[] => {
  const { type } = prop;
  if (!type) {
    return [];
  }
  return (Array.isArray(type) ? type : [type]).map((t) => t.toLowerCase());
};

const mapPhoneType = (prop: VCardProperty): ContactPhone["type"] => {
  const types = paramTypes(prop);
  if (types.some((t) => t === "cell" || t === "mobile" || t === "iphone")) {
    return "mobile";
  }
  if (types.includes("home")) {
    return "home";
  }
  if (types.includes("work")) {
    return "work";
  }
  if (types.length > 0) {
    return "other";
  }
  return undefined;
};

const mapSimpleType = (
  prop: VCardProperty
): "home" | "work" | "other" | undefined => {
  const types = paramTypes(prop);
  if (types.includes("home")) {
    return "home";
  }
  if (types.includes("work")) {
    return "work";
  }
  if (types.length > 0) {
    return "other";
  }
  return undefined;
};

const splitStructured = (value: string): string[] =>
  value.split(";").map((part) => part.trim());

const extractName = (card: vCard): ContactName | undefined => {
  const fn = propString(card.data.fn);
  const n = propString(card.data.n);
  if (!(fn || n)) {
    return undefined;
  }

  const result: ContactName = {};
  if (fn) {
    result.formatted = fn;
  }
  if (n) {
    const [last, first, middle, prefix, suffix] = splitStructured(n);
    if (first) {
      result.first = first;
    }
    if (last) {
      result.last = last;
    }
    if (middle) {
      result.middle = middle;
    }
    if (prefix) {
      result.prefix = prefix;
    }
    if (suffix) {
      result.suffix = suffix;
    }
  }
  return result;
};

const extractPhones = (card: vCard): ContactPhone[] | undefined => {
  const props = asPropertyArray(card.data.tel);
  if (props.length === 0) {
    return undefined;
  }
  return props.map((p) => {
    const entry: ContactPhone = { value: p.valueOf().trim() };
    const type = mapPhoneType(p);
    if (type) {
      entry.type = type;
    }
    return entry;
  });
};

const extractEmails = (card: vCard): ContactEmail[] | undefined => {
  const props = asPropertyArray(card.data.email);
  if (props.length === 0) {
    return undefined;
  }
  return props.map((p) => {
    const entry: ContactEmail = { value: p.valueOf().trim() };
    const type = mapSimpleType(p);
    if (type) {
      entry.type = type;
    }
    return entry;
  });
};

const extractAddresses = (card: vCard): ContactAddress[] | undefined => {
  const props = asPropertyArray(card.data.adr);
  if (props.length === 0) {
    return undefined;
  }
  return props.map((p) => {
    // ADR fields: PO Box; extended; street; locality; region; postal code; country
    const [, , street, city, region, postalCode, country] = splitStructured(
      p.valueOf()
    );
    const entry: ContactAddress = {};
    if (street) {
      entry.street = street;
    }
    if (city) {
      entry.city = city;
    }
    if (region) {
      entry.region = region;
    }
    if (postalCode) {
      entry.postalCode = postalCode;
    }
    if (country) {
      entry.country = country;
    }
    const type = mapSimpleType(p);
    if (type) {
      entry.type = type;
    }
    return entry;
  });
};

const extractOrg = (card: vCard): ContactOrg | undefined => {
  const orgStr = propString(card.data.org);
  const title = propString(card.data.title);
  if (!(orgStr || title)) {
    return undefined;
  }
  const result: ContactOrg = {};
  if (orgStr) {
    const [name, department] = splitStructured(orgStr);
    if (name) {
      result.name = name;
    }
    if (department) {
      result.department = department;
    }
  }
  if (title) {
    result.title = title;
  }
  return result;
};

const extractUrls = (card: vCard): string[] | undefined => {
  const props = asPropertyArray(card.data.url);
  if (props.length === 0) {
    return undefined;
  }
  return props.map((p) => p.valueOf().trim());
};

const photoMimeFromType = (type: string | undefined): string => {
  if (!type) {
    return "image/jpeg";
  }
  const lower = type.toLowerCase();
  if (lower.startsWith("image/")) {
    return lower;
  }
  return `image/${lower}`;
};

const DATA_URI_PATTERN = /^data:([^;,]+);base64,(.*)$/i;

const extractPhoto = (card: vCard): Contact["photo"] | undefined => {
  const [prop] = asPropertyArray(card.data.photo);
  if (!prop) {
    return undefined;
  }
  const value = prop.valueOf();
  // vCard 4.0 can carry a data URI; 3.0 typically uses ENCODING=b with raw base64.
  const dataUriMatch = DATA_URI_PATTERN.exec(value);
  if (dataUriMatch) {
    const [, mimeType, base64] = dataUriMatch;
    const buf = Buffer.from(base64 ?? "", "base64");
    return {
      mimeType: mimeType ?? "image/jpeg",
      read: async () => buf,
    };
  }
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  const buf = Buffer.from(value, "base64");
  return {
    mimeType: photoMimeFromType(type),
    read: async () => buf,
  };
};

const normalizeVCardInput = (vcf: string): string => {
  const withoutBom = vcf.charCodeAt(0) === 0xfe_ff ? vcf.slice(1) : vcf;
  // RFC 6350 mandates CRLF; real-world .vcf files (notably from iMessage)
  // ship with LF- or CR-only line endings, which breaks the `vcf` parser.
  return withoutBom.replace(/\r\n|\r|\n/g, "\r\n");
};

export const fromVCard = (vcf: string): ContactInput => {
  const [card] = vCard.parse(normalizeVCardInput(vcf));
  if (!card) {
    throw new Error("Invalid vCard: no cards parsed");
  }
  const input: ContactInput = { raw: vcf };
  const name = extractName(card);
  if (name) {
    input.name = name;
  }
  const phones = extractPhones(card);
  if (phones) {
    input.phones = phones;
  }
  const emails = extractEmails(card);
  if (emails) {
    input.emails = emails;
  }
  const addresses = extractAddresses(card);
  if (addresses) {
    input.addresses = addresses;
  }
  const org = extractOrg(card);
  if (org) {
    input.org = org;
  }
  const urls = extractUrls(card);
  if (urls) {
    input.urls = urls;
  }
  const birthday = propString(card.data.bday);
  if (birthday) {
    input.birthday = birthday;
  }
  const note = propString(card.data.note);
  if (note) {
    input.note = note;
  }
  const photo = extractPhoto(card);
  if (photo) {
    input.photo = photo;
  }
  return input;
};

const formattedNameFor = (name: ContactName | undefined): string => {
  if (name?.formatted) {
    return name.formatted;
  }
  const parts = [name?.first, name?.middle, name?.last].filter(
    (p): p is string => Boolean(p)
  );
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return "Unknown";
};

const phoneTypeParam = (type: ContactPhone["type"]): string | undefined => {
  if (type === "mobile") {
    return "CELL";
  }
  if (type === "home" || type === "work" || type === "other") {
    return type.toUpperCase();
  }
  return undefined;
};

const simpleTypeParam = (
  type: "home" | "work" | "other" | undefined
): string | undefined => (type ? type.toUpperCase() : undefined);

const photoTypeParam = (mimeType: string): string => {
  const sub = mimeType.split("/")[1] ?? "jpeg";
  return sub.toUpperCase();
};

const writeName = (card: vCard, name: Contact["name"]): void => {
  card.set("fn", formattedNameFor(name));
  if (!name) {
    return;
  }
  if (name.first || name.last || name.middle || name.prefix || name.suffix) {
    card.set(
      "n",
      [
        name.last ?? "",
        name.first ?? "",
        name.middle ?? "",
        name.prefix ?? "",
        name.suffix ?? "",
      ].join(";")
    );
  }
};

const writePhones = (card: vCard, phones: Contact["phones"]): void => {
  for (const phone of phones ?? []) {
    const type = phoneTypeParam(phone.type);
    card.add("tel", phone.value, type ? { type } : undefined);
  }
};

const writeEmails = (card: vCard, emails: Contact["emails"]): void => {
  for (const email of emails ?? []) {
    const type = simpleTypeParam(email.type);
    card.add("email", email.value, type ? { type } : undefined);
  }
};

const writeAddresses = (card: vCard, addresses: Contact["addresses"]): void => {
  for (const addr of addresses ?? []) {
    const value = [
      "",
      "",
      addr.street ?? "",
      addr.city ?? "",
      addr.region ?? "",
      addr.postalCode ?? "",
      addr.country ?? "",
    ].join(";");
    const type = simpleTypeParam(addr.type);
    card.add("adr", value, type ? { type } : undefined);
  }
};

const writeOrg = (card: vCard, org: Contact["org"]): void => {
  if (!org) {
    return;
  }
  if (org.name || org.department) {
    card.set("org", [org.name ?? "", org.department ?? ""].join(";"));
  }
  if (org.title) {
    card.set("title", org.title);
  }
};

const writeUrls = (card: vCard, urls: Contact["urls"]): void => {
  for (const url of urls ?? []) {
    card.add("url", url);
  }
};

const writePhoto = async (
  card: vCard,
  photo: Contact["photo"]
): Promise<void> => {
  if (!photo) {
    return;
  }
  const buf = await photo.read();
  card.set("photo", buf.toString("base64"), {
    encoding: "b",
    type: photoTypeParam(photo.mimeType),
  });
};

export const toVCard = async (contact: Contact): Promise<string> => {
  if (
    typeof contact.raw === "string" &&
    contact.raw.startsWith("BEGIN:VCARD")
  ) {
    return contact.raw;
  }

  const card = new vCard();
  writeName(card, contact.name);
  writePhones(card, contact.phones);
  writeEmails(card, contact.emails);
  writeAddresses(card, contact.addresses);
  writeOrg(card, contact.org);
  writeUrls(card, contact.urls);
  if (contact.birthday) {
    card.set("bday", contact.birthday);
  }
  if (contact.note) {
    card.set("note", contact.note);
  }
  await writePhoto(card, contact.photo);
  return card.toString();
};
