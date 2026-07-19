import z from "zod";

/**
 * Build a Spectrum config env-var name from a channel and a key, centralizing
 * the `SPECTRUM_<CHANNEL>_<KEY>` convention so the prefix can't drift or be
 * mistyped per field. Both segments are joined verbatim (callers pass them
 * already upper-snake-cased), e.g. `envFor("TELEGRAM", "BOT_TOKEN")` →
 * `"SPECTRUM_TELEGRAM_BOT_TOKEN"`.
 */
export const envFor = (channel: string, key: string): string =>
  `SPECTRUM_${channel}_${key}`;

/**
 * Wrap a config-field schema so it falls back to an environment variable when
 * the field is omitted. Precedence is **explicit value > env var > the inner
 * schema's own default/required check**:
 *
 * - An explicit value (anything other than `undefined`) is passed straight
 *   through — a caller-supplied config always wins over the environment.
 * - When the field is `undefined`, `process.env[envKey]` is substituted. An
 *   env var set to the empty string is treated as unset (a common deploy
 *   footgun) so it doesn't satisfy a `.min(1)` by accident.
 * - The inner `schema` then validates the resolved value, keeping its exact
 *   semantics — regex, `.min(1)`, `.url()`, `.optional()`, `.default(...)`.
 *   When both the field and the env var are absent, a required inner schema
 *   raises its normal "required" error.
 *
 * The output type is the inner schema's output type, so call sites are
 * unchanged. Because substitution only happens on `undefined`, wrapping a
 * field inside a `z.object` leaves it a plain key on the parsed result — union
 * discriminators like `"accessToken" in config` keep working.
 *
 * @example
 * ```ts
 * botToken: fromEnv("SPECTRUM_TELEGRAM_BOT_TOKEN", z.string().regex(BOT_TOKEN_PATTERN)),
 * ```
 */
export const fromEnv = <T extends z.ZodType>(envKey: string, schema: T) =>
  z.preprocess((value) => {
    if (value !== undefined) {
      return value;
    }
    const envValue = process.env[envKey];
    return envValue === "" ? undefined : envValue;
  }, schema);

/**
 * Normalize a platform id into the env-var prefix segment: upper-case, with any
 * run of non-alphanumeric characters collapsed to a single `_`. This is a
 * whole-name transform, NOT camelCase splitting, so it reproduces the prefixes
 * canonical platform ids use lowercase snake_case, so `"telegram"` becomes
 * `TELEGRAM` and `"whatsapp_business"` becomes `WHATSAPP_BUSINESS`.
 */
const NON_ALPHANUMERIC_RUN = /[^A-Z0-9]+/;

export const normalizePlatformName = (name: string): string =>
  name.toUpperCase().split(NON_ALPHANUMERIC_RUN).filter(Boolean).join("_");

// Split camelCase (and digit boundaries) so a config key becomes its
// UPPER_SNAKE env suffix i.e `botToken` → `BOT_TOKEN`, `phoneNumberId` →
// `PHONE_NUMBER_ID`, `baseUrl` → `BASE_URL`.
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** Convert a camelCase config field name into its UPPER_SNAKE env-var suffix. */
export const toEnvKey = (field: string): string =>
  field.replace(CAMEL_BOUNDARY, "$1_$2").toUpperCase();

// Zod wrapper node types whose inner schema is reachable via `def.innerType`.
// Unwrapping these lets us see the base type of a decorated field.
const INNER_TYPE_WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "readonly",
  "catch",
  "nonoptional",
  "prefault",
]);

interface ZodInternal {
  def: {
    type: string;
    innerType?: ZodInternal;
    in?: ZodInternal;
    out?: ZodInternal;
    shape?: Record<string, z.ZodType>;
    options?: z.ZodType[];
    catchall?: ZodInternal;
  };
}

const asInternal = (schema: z.ZodType): ZodInternal =>
  schema as unknown as ZodInternal;

// Follow wrapper/pipe nodes down to the base schema so we can classify the leaf.
const unwrapSchema = (schema: z.ZodType): ZodInternal => {
  let current = asInternal(schema);

  for (let depth = 0; depth < 20; depth++) {
    const { type } = current.def;
    if (INNER_TYPE_WRAPPERS.has(type) && current.def.innerType) {
      current = current.def.innerType;
      continue;
    }

    if (type === "pipe" && (current.def.out || current.def.in)) {
      current = (current.def.out ?? current.def.in) as ZodInternal;
      continue;
    }
    break;
  }
  return current;
};

// Only string-leaf fields are env-backed: a single env var is always a string,
// so `z.string()`/`z.url()`/`z.email()` (all base type `"string"`) map cleanly.
const isStringLeaf = (schema: z.ZodType): boolean =>
  unwrapSchema(schema).def.type === "string";

// A strict object carries a `never` catchall. lets a reconstructed
// object preserve `.strict()`.
const isStrictObject = (def: ZodInternal["def"]): boolean =>
  def.catchall?.def.type === "never";

/**
 * Rewrite a platform's config schema so every string-leaf field falls back to
 * `SPECTRUM_<PLATFORM>_<KEY>` when omitted which is the equivalent of
 * hand-wrapping each field with {@link fromEnv}. Called once by
 * `definePlatform`, so adapters declare plain Zod and get env fallback for free.
 *
 * - **object**: each string-leaf field is wrapped with `fromEnv`; non-string
 *   fields (records, arrays, nested objects, booleans, numbers) are left as-is.
 *   The object is only reconstructed when a field actually changed, and
 *   `.strict()` is preserved so an empty strict "cloud" branch is untouched.
 * - **union**: each option is rewritten independently, so an env value only
 *   satisfies the branch that declares that field (a direct/cloud union stays
 *   correctly discriminated).
 * - anything else is returned unchanged.
 *
 * The output type is identical to the input schema's. Only omitted fields gain
 * an env fallback which means that `z.infer` and downstream contexts are unaffected.
 */
export const envAwareConfig = <T extends z.ZodType>(
  name: string,
  schema: T
): T => {
  const prefix = `SPECTRUM_${normalizePlatformName(name)}`;
  return rewrite(prefix, schema) as T;
};

const rewrite = (prefix: string, schema: z.ZodType): z.ZodType => {
  const { def } = asInternal(schema);

  if (def.type === "object" && def.shape) {
    return rewriteObject(prefix, def, schema);
  }

  if (def.type === "union" && def.options) {
    const options = def.options.map((option) => rewrite(prefix, option));
    return z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  return schema;
};

const rewriteObject = (
  prefix: string,
  def: ZodInternal["def"],
  original: z.ZodType
): z.ZodType => {
  const shape = def.shape as Record<string, z.ZodType>;
  const nextShape: Record<string, z.ZodType> = {};
  let changed = false;

  for (const [key, field] of Object.entries(shape)) {
    if (isStringLeaf(field)) {
      nextShape[key] = fromEnv(`${prefix}_${toEnvKey(key)}`, field);
      changed = true;
    } else {
      nextShape[key] = field;
    }
  }

  if (!changed) {
    return original;
  }

  const rebuilt = z.object(nextShape);
  return isStrictObject(def) ? rebuilt.strict() : rebuilt;
};
