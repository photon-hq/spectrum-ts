import { describe, expect, it } from "bun:test";
import { ZodError } from "zod";
import {
  asPoll,
  asPollOption,
  poll,
  pollChoiceSchema,
  pollOptionSchema,
  pollSchema,
} from "./poll";

const validOptions = [{ title: "Yes" }, { title: "No" }];

describe("pollSchema", () => {
  it("parses a poll with a normal title", () => {
    const parsed = pollSchema.parse({
      type: "poll",
      title: "Lunch?",
      options: validOptions,
    });
    expect(parsed.title).toBe("Lunch?");
    expect(parsed.options).toHaveLength(2);
  });

  // Regression: real iMessage polls were dropped because the inbound parser
  // rejected empty titles.
  it("accepts an empty title (lenient on the wire)", () => {
    const parsed = pollSchema.parse({
      type: "poll",
      title: "",
      options: validOptions,
    });
    expect(parsed.title).toBe("");
    expect(parsed.options).toHaveLength(2);
  });

  // Regression: partial inbound deltas can omit the title field entirely.
  it("accepts a missing title (lenient on the wire)", () => {
    const parsed = pollSchema.parse({
      type: "poll",
      options: validOptions,
    });
    expect(parsed.title).toBeUndefined();
    expect(parsed.options).toHaveLength(2);
  });

  it("still rejects titles over 300 chars", () => {
    expect(() =>
      pollSchema.parse({
        type: "poll",
        title: "a".repeat(301),
        options: validOptions,
      })
    ).toThrow(ZodError);
  });

  it("still requires at least 2 options", () => {
    expect(() =>
      pollSchema.parse({
        type: "poll",
        title: "Lunch?",
        options: [{ title: "Only one" }],
      })
    ).toThrow(ZodError);
  });
});

describe("pollChoiceSchema", () => {
  it("accepts an empty option title (lenient on the wire)", () => {
    const parsed = pollChoiceSchema.parse({ title: "" });
    expect(parsed.title).toBe("");
  });

  it("accepts a normal option title", () => {
    const parsed = pollChoiceSchema.parse({ title: "Pizza" });
    expect(parsed.title).toBe("Pizza");
  });
});

describe("pollOptionSchema", () => {
  it("round-trips an empty-title option through the vote payload", () => {
    const emptyOption = { title: "" };
    const pollValue = pollSchema.parse({
      type: "poll",
      title: "",
      options: [emptyOption, { title: "Other" }],
    });
    const parsed = pollOptionSchema.parse({
      type: "poll_option",
      option: emptyOption,
      poll: pollValue,
      selected: true,
      title: "",
    });
    expect(parsed.title).toBe("");
    expect(parsed.option.title).toBe("");
    expect(parsed.selected).toBe(true);
  });

  it("rejects when the vote title disagrees with the option title", () => {
    const pollValue = pollSchema.parse({
      type: "poll",
      title: "Lunch?",
      options: validOptions,
    });
    expect(() =>
      pollOptionSchema.parse({
        type: "poll_option",
        option: { title: "Yes" },
        poll: pollValue,
        selected: true,
        title: "Different",
      })
    ).toThrow(ZodError);
  });
});

describe("customer-facing poll builder", () => {
  it("still produces a poll via asPoll with a title", () => {
    const built = asPoll({ title: "Movie night?", options: validOptions });
    expect(built.title).toBe("Movie night?");
  });

  it("still produces a poll via the poll() builder", async () => {
    const builder = poll("Sushi?", [{ title: "Yes" }, { title: "No" }]);
    const built = await builder.build();
    expect(built.type).toBe("poll");
    if (built.type === "poll") {
      expect(built.title).toBe("Sushi?");
      expect(built.options).toHaveLength(2);
    }
  });

  it("round-trips an option through asPollOption", () => {
    const built = asPoll({ title: "Sushi?", options: validOptions });
    const choice = built.options[0];
    if (!choice) {
      throw new Error("expected an option");
    }
    const voted = asPollOption({ option: choice, poll: built, selected: true });
    expect(voted.title).toBe(choice.title);
  });
});
