import { describe, expect, it } from "bun:test";
import { edit } from "@/content/edit";
import { group } from "@/content/group";
import { markdown } from "@/content/markdown";
import { reply } from "@/content/reply";
import { text } from "@/content/text";
import type { Message } from "@/types/message";

const CONTENT_BUILDER = /not another content builder/;

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
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

  it("marks a stream source as markdown", async () => {
    const built = await markdown(fromArray(["**a", "**"])).build();
    if (built.type !== "streamText") {
      throw new Error("expected streamText content");
    }
    expect(built.format).toBe("markdown");
    // The stream is intact and drainable.
    let full = "";
    for await (const delta of built.stream()) {
      full += delta;
    }
    expect(full).toBe("**a**");
  });

  it("uses a custom extract for stream sources", async () => {
    const built = await markdown(fromArray([{ piece: "**a**" }]), {
      extract: (chunk) => chunk.piece,
    }).build();
    if (built.type !== "streamText") {
      throw new Error("expected streamText content");
    }
    let full = "";
    for await (const delta of built.stream()) {
      full += delta;
    }
    expect(full).toBe("**a**");
  });

  it("rejects a content builder passed as a stream source", () => {
    expect(() =>
      markdown(text("plain") as unknown as AsyncIterable<string>)
    ).toThrow(CONTENT_BUILDER);
  });
});
