import { describe, expect, it } from "bun:test";
import { asPoll } from "@/content/poll";
import {
  buildSend,
  parseMessageId,
} from "@/providers/discord/outbound/message";

describe("parseMessageId", () => {
  it("returns a bare snowflake unchanged", () => {
    expect(parseMessageId("123456789012345678")).toBe("123456789012345678");
  });

  it("recovers the snowflake from a flattened group-item id", () => {
    // Inbound text + attachments become a `group` whose items get ids
    // `${messageId}:${index}`; reacting to / replying to any part must resolve
    // back to the underlying Discord message.
    expect(parseMessageId("123456789012345678:0")).toBe("123456789012345678");
    expect(parseMessageId("123456789012345678:2")).toBe("123456789012345678");
  });

  it("rejects a non-numeric id", () => {
    expect(() => parseMessageId("not-a-snowflake")).toThrow();
  });

  it("rejects a synthetic event id (edit:/reaction:/delete:)", () => {
    expect(() => parseMessageId("edit:111:222")).toThrow();
    expect(() => parseMessageId("reaction:111:222:333:🎉")).toThrow();
  });
});

describe("buildSend — poll", () => {
  it("maps a poll to a Discord poll body with question + ordered answers", async () => {
    const spec = await buildSend(
      asPoll({
        title: "Lunch?",
        options: [{ title: "Tacos" }, { title: "Sushi" }],
      })
    );
    expect(spec.files).toBeUndefined();
    expect(spec.payload.poll).toEqual({
      question: { text: "Lunch?" },
      answers: [
        { poll_media: { text: "Tacos" } },
        { poll_media: { text: "Sushi" } },
      ],
    });
  });

  it("omits duration and allow_multiselect (Discord defaults apply)", async () => {
    const spec = await buildSend(
      asPoll({ title: "Pick", options: [{ title: "A" }, { title: "B" }] })
    );
    expect(spec.payload.poll).not.toHaveProperty("duration");
    expect(spec.payload.poll).not.toHaveProperty("allow_multiselect");
  });
});
