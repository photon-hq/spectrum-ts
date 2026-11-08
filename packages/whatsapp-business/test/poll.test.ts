import type { Poll } from "@spectrum-ts/core";
import { describe, expect, it } from "vitest";
import { pollToInteractive } from "@/poll";

const nativePoll: Poll = {
  type: "poll",
  pollMessageGuid: "poll-a",
  options: [
    { title: "A", optionIdentifier: "option-a" },
    { title: "B", optionIdentifier: "option-b" },
  ],
};

describe("outbound poll titles", () => {
  it.each([
    undefined,
    "",
  ])("rejects a titleless native poll with title %s", (title) => {
    expect(() => pollToInteractive({ ...nativePoll, title })).toThrow(
      "outbound polls require a title"
    );
  });

  it.each([2, 4])("keeps titled polls with %s options supported", (count) => {
    expect(() =>
      pollToInteractive({
        type: "poll",
        title: "Question?",
        options: Array.from({ length: count }, (_, index) => ({
          title: `${index}`,
        })),
      })
    ).not.toThrow();
  });
});
