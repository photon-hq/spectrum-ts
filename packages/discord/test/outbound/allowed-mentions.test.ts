import { describe, expect, it } from "bun:test";
import {
  allowedMentionsSchema,
  configSchema,
  type DiscordConfig,
} from "@/config";
import { resolveAllowedMentions } from "@/outbound/send";

const BOT_TOKEN = "fake.bot.token";

const config = (
  allowedMentions?: DiscordConfig["allowedMentions"]
): DiscordConfig =>
  configSchema.parse({
    botToken: BOT_TOKEN,
    applicationId: "198622483471925248",
    ...(allowedMentions === undefined ? {} : { allowedMentions }),
  });

describe("resolveAllowedMentions", () => {
  it("defaults to parsing every mention type but never pinging the replied-to author", () => {
    // The safe default: in-content @mentions ping as before, but a reply does
    // not ping the message it replies to.
    expect(resolveAllowedMentions(config(), undefined)).toEqual({
      parse: ["users", "roles", "everyone"],
      replied_user: false,
    });
  });

  it("lets content-level allowed_mentions (from `custom`) win verbatim", () => {
    const existing = { parse: [] as never[], replied_user: true };
    expect(resolveAllowedMentions(config(), existing)).toBe(existing);
  });

  it("applies config.allowedMentions, defaulting replied_user to false when unset", () => {
    expect(
      resolveAllowedMentions(config({ parse: ["users"] }), undefined)
    ).toEqual({
      parse: ["users"],
      replied_user: false,
    });
  });

  it("respects an explicit replied_user from config", () => {
    expect(
      resolveAllowedMentions(
        config({ parse: [], replied_user: true }),
        undefined
      )
    ).toEqual({ parse: [], replied_user: true });
  });
});

describe("allowedMentionsSchema", () => {
  it("rejects parse:'users' combined with an explicit users list", () => {
    expect(
      allowedMentionsSchema.safeParse({
        parse: ["users"],
        users: ["198622483471925248"],
      }).success
    ).toBe(false);
  });

  it("rejects parse:'roles' combined with an explicit roles list", () => {
    expect(
      allowedMentionsSchema.safeParse({
        parse: ["roles"],
        roles: ["198622483471925248"],
      }).success
    ).toBe(false);
  });

  it("accepts an explicit id allow-list when its type is not also parsed", () => {
    expect(
      allowedMentionsSchema.safeParse({
        parse: ["roles"],
        users: ["198622483471925248"],
      }).success
    ).toBe(true);
  });

  it("rejects a non-numeric snowflake in an id list", () => {
    expect(
      allowedMentionsSchema.safeParse({ users: ["not-a-snowflake"] }).success
    ).toBe(false);
  });
});
