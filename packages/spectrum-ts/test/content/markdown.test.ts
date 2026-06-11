import { describe, expect, it } from "bun:test";
import { edit } from "@/content/edit";
import { group } from "@/content/group";
import { markdown } from "@/content/markdown";
import { reply } from "@/content/reply";
import { streamText } from "@/content/stream-text";
import { text } from "@/content/text";
import type { Message } from "@/types/message";

async function* fromArray(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

const inboundTarget = {
  id: "1",
  content: { type: "text", text: "x" },
  direction: "inbound",
} as unknown as Message;

const outboundTarget = {
  id: "2",
  content: { type: "text", text: "x" },
  direction: "outbound",
} as unknown as Message;

describe("markdown content", () => {
  it("builds a markdown content value", async () => {
    expect(await markdown("**hi**").build()).toEqual({
      type: "markdown",
      markdown: "**hi**",
    });
  });

  it("rejects an empty string at build time", async () => {
    await expect(markdown("").build()).rejects.toThrow();
  });

  it("can be wrapped in a reply", async () => {
    const built = await reply(markdown("**hi**"), inboundTarget).build();
    expect(built).toEqual({
      type: "reply",
      content: { type: "markdown", markdown: "**hi**" },
      target: inboundTarget,
    });
  });

  it("can be wrapped in an edit", async () => {
    const built = await edit(markdown("**hi**"), outboundTarget).build();
    expect(built).toEqual({
      type: "edit",
      content: { type: "markdown", markdown: "**hi**" },
      target: outboundTarget,
    });
  });

  it("can be a group item", async () => {
    const built = await group(markdown("**caption**"), "plain").build();
    if (built.type !== "group") {
      throw new Error("expected a group content value");
    }
    expect(built.items.map((item) => item.content)).toEqual([
      { type: "markdown", markdown: "**caption**" },
      { type: "text", text: "plain" },
    ]);
  });

  it("wraps a streamText builder, marking the stream as markdown", async () => {
    const built = await markdown(streamText(fromArray(["**a", "**"]))).build();
    if (built.type !== "streamText") {
      throw new Error("expected streamText content");
    }
    expect(built.format).toBe("markdown");
    // The wrapped stream is intact and drainable.
    let full = "";
    for await (const delta of built.stream()) {
      full += delta;
    }
    expect(full).toBe("**a**");
  });

  it("rejects wrapping non-stream content builders", async () => {
    await expect(markdown(text("plain")).build()).rejects.toThrow(
      'can only wrap streamText content (got "text")'
    );
  });
});
