import type { RichEmbed } from "@photon-ai/discord-ts";
import z from "zod";
import { type Attachment, attachmentSchema } from "../../../content/attachment";
import type { Content, ContentBuilder } from "../../../content/types";
import { DISCORD_PLATFORM } from "../config";

const MAX_EMBEDS = 10;
const COLOR_MAX = 0xff_ff_ff; // 16_777_215 — Discord colors are 24-bit integers.
const ATTACHMENT_SCHEME = "attachment://";

// Discord's per-field and combined character limits for embeds. Exceeding any of
// these is a 400 from Discord at send time, so we validate up front with a
// precise message instead.
// https://discord.com/developers/docs/resources/message#embed-object-embed-limits
const LIMIT = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  total: 6000,
} as const;

// Discord rich embeds are Discord-specific — Telegram/iMessage/WhatsApp have no
// equivalent — so this content lives entirely under the Discord provider and
// never enters the universal `Content` discriminated union. The framework
// recognizes it via the generic `__platform` contract: `findUnsupportedPlatformContent`
// in `platform/build.ts` reads the tag and warns-and-skips when a different
// platform receives it. Unlike iMessage's `background`, an embed is
// message-producing (it returns a real Discord message id), so it is NOT tagged
// `__fireAndForget`. `buildSend` narrows it back via the `isEmbed` type guard, so
// an embed also works as the inner content of a `reply` / `group`.
//
// The embed shape is the SDK's `RichEmbed`, passed through verbatim — a thin
// typed wrapper. We only check each entry is an object here; field semantics and
// length limits are enforced by the `superRefine` below.
const richEmbedLike = z.custom<RichEmbed>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v)
);

const len = (value: unknown): number =>
  typeof value === "string" ? value.length : 0;

const validateEmbedLimits = (
  embeds: RichEmbed[],
  ctx: z.RefinementCtx
): void => {
  let total = 0;
  embeds.forEach((embed, i) => {
    const at = `Embed ${i + 1}`;
    const check = (
      value: unknown,
      max: number,
      label: string,
      path: (string | number)[]
    ) => {
      total += len(value);
      if (len(value) > max) {
        ctx.addIssue({
          code: "custom",
          path: ["embeds", i, ...path],
          message: `${at}: ${label} is ${len(value)} characters; Discord's limit is ${max}.`,
        });
      }
    };

    check(embed.title, LIMIT.title, "title", ["title"]);
    check(embed.description, LIMIT.description, "description", ["description"]);
    check(embed.footer?.text, LIMIT.footerText, "footer text", [
      "footer",
      "text",
    ]);
    check(embed.author?.name, LIMIT.authorName, "author name", [
      "author",
      "name",
    ]);

    if (embed.fields && embed.fields.length > LIMIT.fields) {
      ctx.addIssue({
        code: "custom",
        path: ["embeds", i, "fields"],
        message: `${at}: has ${embed.fields.length} fields; Discord allows at most ${LIMIT.fields}.`,
      });
    }
    embed.fields?.forEach((field, j) => {
      check(field.name, LIMIT.fieldName, `field ${j + 1} name`, [
        "fields",
        j,
        "name",
      ]);
      check(field.value, LIMIT.fieldValue, `field ${j + 1} value`, [
        "fields",
        j,
        "value",
      ]);
    });

    if (
      embed.color != null &&
      (!Number.isInteger(embed.color) ||
        embed.color < 0 ||
        embed.color > COLOR_MAX)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["embeds", i, "color"],
        message: `${at}: color must be an integer between 0 and ${COLOR_MAX} (0xFFFFFF); got ${embed.color}. Pass a decimal like 0x5865f2, not a hex string.`,
      });
    }
  });

  if (total > LIMIT.total) {
    ctx.addIssue({
      code: "custom",
      path: ["embeds"],
      message: `Embeds total ${total} characters; Discord allows at most ${LIMIT.total} across all embeds in a single message.`,
    });
  }
};

export const embedSchema = z
  .object({
    type: z.literal("embed"),
    // Must equal the provider's definePlatform name (DISCORD_PLATFORM); the
    // dispatch guard in platform/build.ts compares this with a strict,
    // case-sensitive `!==`, so a capitalized "Discord" would be silently skipped.
    __platform: z.literal(DISCORD_PLATFORM),
    embeds: z
      .array(richEmbedLike)
      .min(1, "embed() requires at least one embed.")
      .max(
        MAX_EMBEDS,
        `A Discord message can carry at most ${MAX_EMBEDS} embeds.`
      ),
    content: z.string().optional(),
    // Files referenced by `attachment://<name>` in an embed's image/thumbnail/
    // author/footer. Uploaded in the same message-create request so the embed can
    // render a local image (an external `image.url` needs no file).
    files: z.array(attachmentSchema).optional(),
  })
  .superRefine((value, ctx) => {
    validateEmbedLimits(value.embeds, ctx);
  });

export type Embed = z.infer<typeof embedSchema>;

export const isEmbed = (v: unknown): v is Embed =>
  embedSchema.safeParse(v).success;

export const asEmbed = (
  embeds: RichEmbed | RichEmbed[],
  options?: { content?: string; files?: Attachment[] }
): Embed =>
  embedSchema.parse({
    type: "embed",
    __platform: DISCORD_PLATFORM,
    embeds: Array.isArray(embeds) ? embeds : [embeds],
    ...(options?.content === undefined ? {} : { content: options.content }),
    ...(options?.files === undefined ? {} : { files: options.files }),
  });

// Every `attachment://<name>` referenced by an embed must have a matching file in
// `options.files`, or Discord renders a broken image. Checked at build time
// (after files resolve) so a typo'd or forgotten file fails fast with a clear
// message rather than as a silently broken embed.
const assertAttachmentRefs = (value: Embed): void => {
  const provided = new Set((value.files ?? []).map((file) => file.name));
  value.embeds.forEach((embed, i) => {
    const refs: [string, string | null | undefined][] = [
      ["image.url", embed.image?.url],
      ["thumbnail.url", embed.thumbnail?.url],
      ["author.icon_url", embed.author?.icon_url],
      ["footer.icon_url", embed.footer?.icon_url],
    ];
    for (const [where, url] of refs) {
      if (typeof url === "string" && url.startsWith(ATTACHMENT_SCHEME)) {
        const filename = url.slice(ATTACHMENT_SCHEME.length);
        if (!provided.has(filename)) {
          throw new Error(
            `Embed ${i + 1} ${where} references "${url}", but no file named "${filename}" was passed in options.files.`
          );
        }
      }
    }
  });
};

const resolveEmbedFile = async (file: ContentBuilder): Promise<Attachment> => {
  const resolved = await file.build();
  if (resolved.type !== "attachment") {
    throw new Error(
      `embed() files must be attachment(...) content (got "${resolved.type}").`
    );
  }
  return resolved;
};

export interface EmbedOptions {
  content?: string;
  /**
   * Files uploaded alongside the embeds, each an `attachment(...)` builder.
   * Reference one from an embed via `image: { url: "attachment://<name>" }`
   * (or `thumbnail` / `author.icon_url` / `footer.icon_url`), where `<name>`
   * matches the attachment's filename.
   */
  files?: ContentBuilder[];
}

/**
 * Discord-only rich embed(s). Sends one Discord message carrying up to 10 embeds
 * plus optional leading text — all in one message.
 *
 * - `embed({ title: "Release", description: "…", color: 0x5865f2 })` — one embed.
 * - `embed([cardA, cardB], { content: "see below 👇" })` — multiple embeds with
 *   accompanying text.
 * - `embed({ image: { url: "attachment://chart.png" } }, { files: [attachment("./chart.png")] })`
 *   — an embed rendering a locally uploaded image.
 *
 * The embed object is Discord's `RichEmbed` (title, description, fields, footer,
 * image, thumbnail, author, color, timestamp, url) and is passed through verbatim.
 * Discord's embed limits (title ≤256, description ≤4096, ≤25 fields, ≤6000 total,
 * 24-bit integer `color`, …) are validated up front so an overflow fails here
 * rather than as a 400 at send time.
 *
 * `space.send(embed(...))` is the canonical form; an embed may also be the inner
 * content of `reply(embed(...))` or an item of `group(...)`.
 *
 * `Embed` is intentionally not a member of the universal `Content` union — the
 * `as unknown as Content` cast keeps the builder shape compatible with the
 * framework's `ContentBuilder.build(): Promise<Content>` signature; the Discord
 * provider narrows it back via `isEmbed` at dispatch.
 */
export function embed(
  embeds: RichEmbed | RichEmbed[],
  options?: EmbedOptions
): ContentBuilder {
  // Validate the embeds eagerly at construction so a bad shape/limit fails fast,
  // before any file IO. Files are resolved (and their `attachment://` refs
  // checked) at build time.
  asEmbed(embeds, { content: options?.content });
  return {
    build: async () => {
      const files = options?.files
        ? await Promise.all(options.files.map(resolveEmbedFile))
        : undefined;
      const value = asEmbed(embeds, { content: options?.content, files });
      assertAttachmentRefs(value);
      return value as unknown as Content;
    },
  };
}
