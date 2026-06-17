import type {
  ActionRowComponentForMessageRequest,
  ButtonComponentForMessageRequest,
  ChannelSelectComponentForMessageRequest,
  ComponentEmojiForRequest,
  MentionableSelectComponentForMessageRequest,
  RoleSelectComponentForMessageRequest,
  StringSelectComponentForMessageRequest,
  StringSelectOptionForRequest,
  UserSelectComponentForMessageRequest,
} from "@photon-ai/discord-ts";
import z from "zod";
import type { Content, ContentBuilder } from "../../../content/types";
import { DISCORD_PLATFORM } from "../config";

// One Discord message can carry at most five action rows; each row holds up to
// five buttons OR a single select menu (the two never share a row).
const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;

// Discord's component limits. Exceeding any is a 400 from Discord at send time,
// so we validate up front with a precise message instead.
// https://discord.com/developers/docs/components/reference
const LIMIT = {
  customId: 100,
  buttonLabel: 80,
  selectPlaceholder: 150,
  selectOptions: 25,
  optionLabel: 100,
  optionValue: 100,
  optionDescription: 100,
} as const;

// Discord component `type` discriminators (numeric in the wire format).
const ROW_TYPE = 1;
const BUTTON_TYPE = 2;
const STRING_SELECT_TYPE = 3;
// User/role/mentionable/channel selects — they share the "one select per row,
// custom_id required" rules with the string select but carry no `options`.
const SELECT_TYPES = new Set([3, 5, 6, 7, 8]);

// Button styles. Link buttons (5) carry a `url` and no `custom_id`; premium
// buttons (6) carry a `sku_id`; every other style needs a `custom_id`.
export const ButtonStyle = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
  premium: 6,
} as const;

export type ActionRow = ActionRowComponentForMessageRequest;
type Button = ButtonComponentForMessageRequest;
type Select =
  | StringSelectComponentForMessageRequest
  | UserSelectComponentForMessageRequest
  | RoleSelectComponentForMessageRequest
  | MentionableSelectComponentForMessageRequest
  | ChannelSelectComponentForMessageRequest;
type RowChild = Button | Select;

// Action rows are the SDK's `ActionRowComponentForMessageRequest`, passed through
// verbatim — a thin typed wrapper. We only check each entry is an object here;
// the structural rules (rows ≤5, one select per row, custom_id ≤100, …) are
// enforced by the `superRefine` below.
const actionRowLike = z.custom<ActionRow>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v)
);

const len = (value: unknown): number =>
  typeof value === "string" ? value.length : 0;

const validateButton = (
  button: Button,
  ctx: z.RefinementCtx,
  basePath: (string | number)[],
  at: string
): void => {
  if (len(button.label) > LIMIT.buttonLabel) {
    ctx.addIssue({
      code: "custom",
      path: [...basePath, "label"],
      message: `${at}: label is ${len(button.label)} characters; Discord's limit is ${LIMIT.buttonLabel}.`,
    });
  }
  if (len(button.custom_id) > LIMIT.customId) {
    ctx.addIssue({
      code: "custom",
      path: [...basePath, "custom_id"],
      message: `${at}: custom_id is ${len(button.custom_id)} characters; Discord's limit is ${LIMIT.customId}.`,
    });
  }
  if (button.style === ButtonStyle.link) {
    if (!button.url) {
      ctx.addIssue({
        code: "custom",
        path: [...basePath, "url"],
        message: `${at}: a link button (style 5) requires a url.`,
      });
    }
    if (button.custom_id) {
      ctx.addIssue({
        code: "custom",
        path: [...basePath, "custom_id"],
        message: `${at}: a link button (style 5) must not carry a custom_id.`,
      });
    }
    return;
  }
  if (button.style === ButtonStyle.premium) {
    if (!button.sku_id) {
      ctx.addIssue({
        code: "custom",
        path: [...basePath, "sku_id"],
        message: `${at}: a premium button (style 6) requires a sku_id.`,
      });
    }
    return;
  }
  if (!button.custom_id) {
    ctx.addIssue({
      code: "custom",
      path: [...basePath, "custom_id"],
      message: `${at}: a button requires a custom_id (or use a link button with a url).`,
    });
  }
};

const validateSelectOptions = (
  select: StringSelectComponentForMessageRequest,
  ctx: z.RefinementCtx,
  basePath: (string | number)[],
  at: string
): void => {
  const options = select.options ?? [];
  if (options.length === 0 || options.length > LIMIT.selectOptions) {
    ctx.addIssue({
      code: "custom",
      path: [...basePath, "options"],
      message: `${at}: has ${options.length} options; a string select needs 1–${LIMIT.selectOptions}.`,
    });
  }
  options.forEach((option, k) => {
    const checks: [keyof StringSelectOptionForRequest, number, string][] = [
      ["label", LIMIT.optionLabel, "label"],
      ["value", LIMIT.optionValue, "value"],
      ["description", LIMIT.optionDescription, "description"],
    ];
    for (const [key, max, label] of checks) {
      if (len(option[key]) > max) {
        ctx.addIssue({
          code: "custom",
          path: [...basePath, "options", k, key],
          message: `${at}: option ${k + 1} ${label} is ${len(option[key])} characters; Discord's limit is ${max}.`,
        });
      }
    }
  });
};

const validateSelect = (
  select: Select,
  ctx: z.RefinementCtx,
  basePath: (string | number)[],
  at: string
): void => {
  if (!select.custom_id) {
    ctx.addIssue({
      code: "custom",
      path: [...basePath, "custom_id"],
      message: `${at}: a select menu requires a custom_id.`,
    });
  } else if (len(select.custom_id) > LIMIT.customId) {
    ctx.addIssue({
      code: "custom",
      path: [...basePath, "custom_id"],
      message: `${at}: custom_id is ${len(select.custom_id)} characters; Discord's limit is ${LIMIT.customId}.`,
    });
  }
  if (len(select.placeholder) > LIMIT.selectPlaceholder) {
    ctx.addIssue({
      code: "custom",
      path: [...basePath, "placeholder"],
      message: `${at}: placeholder is ${len(select.placeholder)} characters; Discord's limit is ${LIMIT.selectPlaceholder}.`,
    });
  }
  if (select.type === STRING_SELECT_TYPE) {
    validateSelectOptions(select, ctx, basePath, at);
  }
};

const validateRow = (row: ActionRow, i: number, ctx: z.RefinementCtx): void => {
  const at = `Row ${i + 1}`;
  const path: (string | number)[] = ["components", i];
  if (row.type !== ROW_TYPE) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `${at}: must be an action row (type 1); pass buttons/selects via row(...).`,
    });
    return;
  }
  const children = (row.components ?? []) as RowChild[];
  if (children.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "components"],
      message: `${at}: an action row must hold at least one component.`,
    });
    return;
  }
  const hasSelect = children.some((child) => SELECT_TYPES.has(child.type));
  if (hasSelect && children.length > 1) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "components"],
      message: `${at}: a select menu must be the only component in its row.`,
    });
  }
  if (!hasSelect && children.length > MAX_BUTTONS_PER_ROW) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "components"],
      message: `${at}: has ${children.length} buttons; a row allows at most ${MAX_BUTTONS_PER_ROW}.`,
    });
  }
  children.forEach((child, j) => {
    const childPath = [...path, "components", j];
    const childAt = `${at} component ${j + 1}`;
    if (child.type === BUTTON_TYPE) {
      validateButton(child, ctx, childPath, childAt);
    } else if (SELECT_TYPES.has(child.type)) {
      validateSelect(child, ctx, childPath, childAt);
    } else {
      ctx.addIssue({
        code: "custom",
        path: childPath,
        message: `${childAt}: must be a button or select menu.`,
      });
    }
  });
};

export const componentsSchema = z
  .object({
    type: z.literal("components"),
    // Must equal the provider's definePlatform name (DISCORD_PLATFORM) so the
    // dispatch guard in platform/build.ts narrows this as Discord-supported
    // content rather than skipping it (the comparison is a strict, case-sensitive
    // `!==`, so a capitalized "Discord" here would be silently dropped).
    __platform: z.literal(DISCORD_PLATFORM),
    components: z
      .array(actionRowLike)
      .min(1, "components() requires at least one action row.")
      .max(
        MAX_ROWS,
        `A Discord message can carry at most ${MAX_ROWS} action rows.`
      ),
    content: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    value.components.forEach((actionRow, i) => {
      validateRow(actionRow, i, ctx);
    });
  });

export type Components = z.infer<typeof componentsSchema>;

export const isComponents = (v: unknown): v is Components =>
  componentsSchema.safeParse(v).success;

export const asComponents = (
  rows: ActionRow | ActionRow[],
  options?: { content?: string }
): Components =>
  componentsSchema.parse({
    type: "components",
    __platform: DISCORD_PLATFORM,
    components: Array.isArray(rows) ? rows : [rows],
    ...(options?.content === undefined ? {} : { content: options.content }),
  });

// ---------------------------------------------------------------------------
// Ergonomic constructors — the wire format uses numeric `type`/`style`
// discriminators, so these build the SDK shapes for you. They are thin: every
// returned value is exactly the `@photon-ai/discord-ts` request type, so an
// advanced caller can also hand-write the objects and pass them to components().
// ---------------------------------------------------------------------------

export interface ButtonSpec {
  customId: string;
  disabled?: boolean;
  emoji?: ComponentEmojiForRequest;
  label?: string;
  style?: (typeof ButtonStyle)[keyof typeof ButtonStyle];
}

/** A clickable button that emits an interaction carrying `customId`. */
export const button = (spec: ButtonSpec): Button => ({
  type: BUTTON_TYPE,
  style: spec.style ?? ButtonStyle.secondary,
  custom_id: spec.customId,
  ...(spec.label === undefined ? {} : { label: spec.label }),
  ...(spec.emoji === undefined ? {} : { emoji: spec.emoji }),
  ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
});

/** A link button (style 5) that opens `url` — emits no interaction. */
export const linkButton = (spec: {
  url: string;
  label?: string;
  emoji?: ComponentEmojiForRequest;
  disabled?: boolean;
}): Button => ({
  type: BUTTON_TYPE,
  style: ButtonStyle.link,
  url: spec.url,
  ...(spec.label === undefined ? {} : { label: spec.label }),
  ...(spec.emoji === undefined ? {} : { emoji: spec.emoji }),
  ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
});

/** A string select menu — the user picks from `options`. */
export const select = (spec: {
  customId: string;
  options: StringSelectOptionForRequest[];
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}): StringSelectComponentForMessageRequest => ({
  type: STRING_SELECT_TYPE,
  custom_id: spec.customId,
  options: spec.options,
  ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
  ...(spec.minValues === undefined ? {} : { min_values: spec.minValues }),
  ...(spec.maxValues === undefined ? {} : { max_values: spec.maxValues }),
  ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
});

/** Wrap up to five buttons (or a single select) into one action row. */
export const row = (...children: RowChild[]): ActionRow => ({
  type: ROW_TYPE,
  components: children,
});

/**
 * Discord-only interactive components — buttons and select menus laid out in up
 * to five action rows, attached to one Discord message (with optional text).
 *
 * - `components(row(button({ customId: "ok", label: "OK", style: ButtonStyle.success })))`
 * - `components([row(linkButton({ url: "https://…", label: "Docs" }))], { content: "see below 👇" })`
 * - `components(row(select({ customId: "pick", options: [{ label: "A", value: "a" }] })))`
 *
 * Each row holds at most five buttons, or exactly one select menu. Discord's
 * limits (≤5 rows, custom_id ≤100, button label ≤80, ≤25 select options, …) are
 * validated up front so an overflow fails here rather than as a 400 at send time.
 *
 * `space.send(components(...))` is the canonical form; components may also be the
 * inner content of `reply(components(...))` or an item of `group(...)`.
 *
 * Like `embed`, `Components` is intentionally not a member of the universal
 * `Content` union — the `as unknown as Content` cast keeps the builder shape
 * compatible with `ContentBuilder.build(): Promise<Content>`; the Discord
 * provider narrows it back via `isComponents` at dispatch.
 */
export function components(
  rows: ActionRow | ActionRow[],
  options?: { content?: string }
): ContentBuilder {
  // Validate eagerly at construction so a bad shape/limit fails fast.
  const value = asComponents(rows, options);
  return {
    build: () => Promise.resolve(value as unknown as Content),
  };
}
