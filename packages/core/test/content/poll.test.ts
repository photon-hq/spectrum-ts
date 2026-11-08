import { describe, expect, it } from "vitest";
import {
  asPoll,
  asPollOption,
  poll,
  pollOptionSchema,
  pollSchema,
} from "@/content/poll";
import { contentSchema } from "@/content/types";

const nativePoll = () =>
  asPoll({
    pollMessageGuid: "poll-a",
    options: [
      { title: "Same label", optionIdentifier: "option-a" },
      { title: "Same label", optionIdentifier: "option-b" },
    ],
  });

describe("poll identity", () => {
  it("accepts titleless native polls without inventing display text", () => {
    const value = nativePoll();
    expect(value).not.toHaveProperty("title");
    expect(contentSchema.parse(value)).toEqual(value);
    expect(value.pollMessageGuid).toBe("poll-a");
    expect(value.options.map((choice) => choice.optionIdentifier)).toEqual([
      "option-a",
      "option-b",
    ]);
  });

  it("keeps legacy and outbound poll validation and shapes", async () => {
    await expect(poll("", "A", "B").build()).rejects.toThrow();
    expect(() =>
      asPoll({ title: "", options: [{ title: "A" }, { title: "B" }] })
    ).toThrow();
    expect(() =>
      asPoll({ options: [{ title: "A" }, { title: "B" }] })
    ).toThrow();
    const value = await poll("Question?", "A", "B").build();
    expect(value).toEqual({
      type: "poll",
      title: "Question?",
      options: [{ title: "A" }, { title: "B" }],
    });
    expect(() =>
      asPoll({ title: "Question?", options: [{ title: "A" }] })
    ).toThrow();
    expect(() =>
      asPoll({ title: "Question?", options: [{ title: "" }, { title: "B" }] })
    ).toThrow();
    expect(() =>
      asPoll({
        title: "x".repeat(301),
        options: [{ title: "A" }, { title: "B" }],
      })
    ).toThrow();
  });

  it("requires complete, distinct native option identifiers", () => {
    const value = nativePoll();
    expect(
      pollSchema.safeParse({ ...value, pollMessageGuid: "" }).success
    ).toBe(false);
    expect(
      pollSchema.safeParse({
        ...value,
        options: [{ title: "A" }, value.options[1]],
      }).success
    ).toBe(false);
    expect(
      pollSchema.safeParse({
        ...value,
        options: [value.options[0], value.options[0]],
      }).success
    ).toBe(false);
  });

  it.each([
    "created",
    "optionAdded",
  ] as const)("retains %s as a definition snapshot", (change) => {
    const value = asPoll({ ...nativePoll(), change });
    expect(contentSchema.parse(value)).toEqual(value);
    expect(value.change).toBe(change);
    expect("selected" in value).toBe(false);
    expect(
      pollSchema.safeParse({
        type: "poll",
        title: "Question?",
        options: [{ title: "A" }, { title: "B" }],
        change,
      }).success
    ).toBe(false);
  });

  it("distinguishes votes for options with the same label", () => {
    const parent = nativePoll();
    const first = asPollOption({
      poll: parent,
      option: { title: "Same label", optionIdentifier: "option-a" },
      selected: true,
    });
    const second = asPollOption({
      poll: parent,
      option: { title: "Same label", optionIdentifier: "option-b" },
      selected: true,
    });
    expect(first.pollMessageGuid).toBe("poll-a");
    expect(first.option.optionIdentifier).toBe("option-a");
    expect(second.option.optionIdentifier).toBe("option-b");
    expect(contentSchema.parse(second)).toEqual(second);
    expect(() =>
      asPollOption({
        poll: parent,
        option: { title: "Same label", optionIdentifier: "unknown" },
        selected: true,
      })
    ).toThrow();
    expect(() =>
      asPollOption({
        poll: parent,
        option: { title: "Same label" },
        selected: true,
      })
    ).toThrow();
  });

  it("rejects mismatched poll identity and selection labels", () => {
    const parent = nativePoll();
    const value = asPollOption({
      poll: parent,
      option: { title: "Same label", optionIdentifier: "option-a" },
      selected: false,
    });
    expect(value.selected).toBe(false);
    expect(
      pollOptionSchema.safeParse({ ...value, pollMessageGuid: "poll-b" })
        .success
    ).toBe(false);
    expect(
      pollOptionSchema.safeParse({ ...value, title: "Wrong label" }).success
    ).toBe(false);
    expect(
      pollOptionSchema.safeParse({
        ...value,
        title: "Wrong label",
        option: { title: "Wrong label", optionIdentifier: "option-a" },
      }).success
    ).toBe(false);
  });

  it("retains legacy label matching for polls without native identifiers", () => {
    const parent = asPoll({
      title: "Question?",
      options: [{ title: "A" }, { title: "B" }],
    });
    expect(
      asPollOption({ poll: parent, option: { title: "A" }, selected: true })
    ).toEqual({
      type: "poll_option",
      title: "A",
      option: { title: "A" },
      poll: parent,
      selected: true,
    });
    expect(() =>
      asPollOption({ poll: parent, option: { title: "C" }, selected: true })
    ).toThrow();
  });
});
