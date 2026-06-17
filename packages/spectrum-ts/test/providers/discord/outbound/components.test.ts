import { describe, expect, it } from "bun:test";
import { asReply } from "@/content/reply";
import type { Content } from "@/content/types";
import { DISCORD_PLATFORM } from "@/providers/discord/config";
import {
  asComponents,
  ButtonStyle,
  button,
  components,
  isComponents,
  linkButton,
  row,
  select,
} from "@/providers/discord/content/components";
import {
  buildSend,
  componentsToSpec,
} from "@/providers/discord/outbound/message";

const okButton = button({
  customId: "ok",
  label: "OK",
  style: ButtonStyle.success,
});

describe("constructors", () => {
  it("button builds the SDK shape with a default secondary style", () => {
    expect(button({ customId: "x", label: "X" })).toEqual({
      type: 2,
      style: 2,
      custom_id: "x",
      label: "X",
    });
  });

  it("linkButton carries a url and no custom_id", () => {
    expect(linkButton({ url: "https://x.dev", label: "Docs" })).toEqual({
      type: 2,
      style: 5,
      url: "https://x.dev",
      label: "Docs",
    });
  });

  it("select maps camelCase options to the wire format", () => {
    expect(
      select({
        customId: "pick",
        options: [{ label: "A", value: "a" }],
        minValues: 1,
        maxValues: 2,
      })
    ).toEqual({
      type: 3,
      custom_id: "pick",
      options: [{ label: "A", value: "a" }],
      min_values: 1,
      max_values: 2,
    });
  });

  it("row wraps children into an action row", () => {
    expect(row(okButton)).toEqual({ type: 1, components: [okButton] });
  });
});

describe("asComponents", () => {
  it("wraps a single row and optional text, tagged for Discord", () => {
    expect(asComponents(row(okButton), { content: "hi" })).toEqual({
      type: "components",
      __platform: "discord",
      components: [{ type: 1, components: [okButton] }],
      content: "hi",
    });
  });

  it("tags __platform with the provider's registered name so dispatch does not skip it", () => {
    // The dispatch guard (platform/build.ts) compares this tag against the
    // provider's definePlatform name with a strict, case-sensitive `!==`. If the
    // two ever drift (e.g. "Discord" vs "discord"), every components() send is
    // silently dropped as "unsupported", so pin them equal here.
    expect(asComponents(row(okButton)).__platform).toBe(DISCORD_PLATFORM);
  });

  it("accepts an array of rows without text", () => {
    const value = asComponents([row(okButton), row(okButton)]);
    expect(value.components).toHaveLength(2);
    expect(value).not.toHaveProperty("content");
  });

  it("rejects an empty list", () => {
    expect(() => asComponents([])).toThrow("at least one action row");
  });

  it("rejects more than 5 action rows", () => {
    const six = Array.from({ length: 6 }, () => row(okButton));
    expect(() => asComponents(six)).toThrow("at most 5 action rows");
  });
});

describe("asComponents — Discord limit validation", () => {
  it("rejects more than 5 buttons in a row", () => {
    const sixButtons = Array.from({ length: 6 }, (_, i) =>
      button({ customId: `b${i}`, label: `${i}` })
    );
    expect(() => asComponents(row(...sixButtons))).toThrow(
      "has 6 buttons; a row allows at most 5"
    );
  });

  it("rejects a select sharing a row with a button", () => {
    expect(() =>
      asComponents(
        row(
          okButton,
          select({ customId: "s", options: [{ label: "A", value: "a" }] })
        )
      )
    ).toThrow("a select menu must be the only component in its row");
  });

  it("rejects an over-long custom_id", () => {
    expect(() =>
      asComponents(row(button({ customId: "x".repeat(101), label: "X" })))
    ).toThrow("custom_id is 101 characters; Discord's limit is 100");
  });

  it("rejects an over-long button label", () => {
    expect(() =>
      asComponents(row(button({ customId: "x", label: "y".repeat(81) })))
    ).toThrow("label is 81 characters; Discord's limit is 80");
  });

  it("rejects a non-link button with no custom_id", () => {
    expect(() =>
      asComponents(row({ type: 2, style: ButtonStyle.primary } as never))
    ).toThrow("a button requires a custom_id");
  });

  it("rejects a link button carrying a custom_id", () => {
    expect(() =>
      asComponents(
        row({
          type: 2,
          style: ButtonStyle.link,
          url: "https://x",
          custom_id: "no",
        } as never)
      )
    ).toThrow("must not carry a custom_id");
  });

  it("rejects an empty action row", () => {
    expect(() => asComponents({ type: 1, components: [] } as never)).toThrow(
      "must hold at least one component"
    );
  });

  it("rejects a string select with more than 25 options", () => {
    const options = Array.from({ length: 26 }, (_, i) => ({
      label: `${i}`,
      value: `${i}`,
    }));
    expect(() => asComponents(row(select({ customId: "s", options })))).toThrow(
      "has 26 options; a string select needs 1–25"
    );
  });

  it("rejects an over-long select option label", () => {
    expect(() =>
      asComponents(
        row(
          select({
            customId: "s",
            options: [{ label: "y".repeat(101), value: "a" }],
          })
        )
      )
    ).toThrow("option 1 label is 101 characters; Discord's limit is 100");
  });
});

describe("components builder", () => {
  it("builds Discord-scoped components content", async () => {
    const built: unknown = await components(row(okButton), {
      content: "hi",
    }).build();
    expect(built).toEqual({
      type: "components",
      __platform: "discord",
      components: [{ type: 1, components: [okButton] }],
      content: "hi",
    });
  });

  it("validates eagerly at construction (oversize list throws before build)", () => {
    const six = Array.from({ length: 6 }, () => row(okButton));
    expect(() => components(six)).toThrow("at most 5 action rows");
  });
});

describe("isComponents", () => {
  it("is true for components content", () => {
    expect(isComponents(asComponents(row(okButton)))).toBe(true);
  });

  it("is false for plain content", () => {
    expect(isComponents({ type: "text", text: "hi" })).toBe(false);
  });
});

describe("componentsToSpec", () => {
  it("maps rows + text into one message-create body", () => {
    const spec = componentsToSpec(
      asComponents(row(okButton), { content: "pick 👇" })
    );
    expect(spec.files).toBeUndefined();
    expect(spec.payload).toEqual({
      content: "pick 👇",
      components: [{ type: 1, components: [okButton] }],
    });
  });

  it("omits content when no text was given", () => {
    const spec = componentsToSpec(asComponents(row(okButton)));
    expect(spec.payload).not.toHaveProperty("content");
    expect(spec.payload.components).toEqual([
      { type: 1, components: [okButton] },
    ]);
  });
});

describe("components — nested in reply / buildSend", () => {
  it("buildSend maps top-level components directly", async () => {
    const spec = await buildSend(
      asComponents(row(okButton), { content: "pick" }) as unknown as Content
    );
    expect(spec.payload).toEqual({
      content: "pick",
      components: [{ type: 1, components: [okButton] }],
    });
  });

  it("reply(components) carries the components plus message_reference", async () => {
    const reply = asReply({
      content: asComponents(row(okButton)) as never,
      target: { id: "999", content: { type: "text", text: "x" } } as never,
    });
    const spec = await buildSend(reply);
    expect(spec.payload.components).toEqual([
      { type: 1, components: [okButton] },
    ]);
    expect(spec.payload.message_reference).toEqual({ message_id: "999" });
  });
});
