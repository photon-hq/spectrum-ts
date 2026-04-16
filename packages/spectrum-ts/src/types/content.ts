import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import type { NonEmptyString } from "type-fest";
import z from "zod";

const DEFAULT_ATTACHMENT_NAME = "attachment";

const contentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plain_text"),
    text: z.string().nonempty(),
  }),
  z.object({
    type: z.literal("custom"),
    raw: z.json(),
  }),
  z.object({
    type: z.literal("attachment"),
    data: z.instanceof(Buffer),
    mimeType: z.string().nonempty(),
    name: z.string().nonempty(),
  }),
]);

export type Content = z.infer<typeof contentSchema>;

export interface ContentBuilder {
  build(): Promise<Content>;
}

export function text(
  text: string
): ContentBuilder {
  return {
    build: (): Promise<Content> =>
      Promise.resolve({ type: "plain_text", text }),
  };
}

export function custom(
  raw: z.infer<ReturnType<typeof z.json>>
): ContentBuilder {
  return {
    build: (): Promise<Content> => Promise.resolve({ type: "custom", raw }),
  };
}

const resolveAttachmentName = (input: string | Buffer, name?: string): string =>
  name ||
  (typeof input === "string" ? basename(input) : DEFAULT_ATTACHMENT_NAME);

const resolveAttachmentMimeType = (name: string, mimeType?: string): string => {
  if (mimeType) {
    return mimeType;
  }

  const resolvedMimeType = lookupMimeType(name);
  if (!resolvedMimeType) {
    throw new Error(
      `Unable to resolve MIME type for attachment "${name}". Pass options.mimeType explicitly.`
    );
  }

  return resolvedMimeType;
};

export function attachment(
  input: string | Buffer,
  options?: { mimeType?: string; name?: string }
): ContentBuilder {
  return {
    build: async (): Promise<Content> => {
      const data = typeof input === "string" ? await readFile(input) : input;
      const name = resolveAttachmentName(input, options?.name);

      return {
        data,
        mimeType: resolveAttachmentMimeType(name, options?.mimeType),
        name,
        type: "attachment",
      };
    },
  };
}
