import type { Message } from "@spectrum-ts/core";
import { asCustom, asReply, asText } from "@spectrum-ts/core/authoring";
import { expect, it } from "vitest";
import { isIMessageConversationEvent } from "@/conversation-events";

const eventContent = asCustom({
  imessage_type: "conversation-event",
  itemType: "chatAction",
});
const target = { id: "target", content: eventContent } as Message;

it("recognizes reply-wrapped updates without classifying replies to updates", () => {
  expect(
    isIMessageConversationEvent({
      content: asReply({ content: eventContent, target }),
    })
  ).toBe(true);
  expect(
    isIMessageConversationEvent({
      content: asReply({ content: asText("Hello"), target }),
    })
  ).toBe(false);
});

it.each([
  null,
  "conversation-event",
  { imessage_type: "unsupported-message" },
  { imessage_type: "reply-target", itemType: "chatAction" },
  { imessage_type: "conversation-event", itemType: "normal" },
  { imessage_type: "conversation-event" },
])("does not classify unrelated or malformed custom payloads: %j", (raw) => {
  expect(isIMessageConversationEvent({ content: asCustom(raw) })).toBe(false);
});
