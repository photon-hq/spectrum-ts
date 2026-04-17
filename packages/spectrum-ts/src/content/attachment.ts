import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import z from "zod";
import type { ContentBuilder } from "./types";

const DEFAULT_ATTACHMENT_NAME = "attachment";

export const attachmentSchema = z.object({
  type: z.literal("attachment"),
  data: z.instanceof(Buffer),
  mimeType: z.string().nonempty(),
  name: z.string().nonempty(),
});

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

export const asAttachment = (input: {
  data: Buffer;
  mimeType: string;
  name: string;
}): z.infer<typeof attachmentSchema> =>
  attachmentSchema.parse({ type: "attachment", ...input });

export function attachment(
  input: string | Buffer,
  options?: { mimeType?: string; name?: string }
): ContentBuilder {
  return {
    build: async () => {
      const data = typeof input === "string" ? await readFile(input) : input;
      const name = resolveAttachmentName(input, options?.name);
      return asAttachment({
        data,
        mimeType: resolveAttachmentMimeType(name, options?.mimeType),
        name,
      });
    },
  };
}
