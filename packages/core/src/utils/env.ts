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
