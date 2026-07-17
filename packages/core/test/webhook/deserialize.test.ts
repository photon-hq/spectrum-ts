import { describe, expect, it } from "vitest";
import type { Attachment } from "@/content/attachment";
import type { Reaction } from "@/content/reaction";
import type { Reply } from "@/content/reply";
import type { Voice } from "@/content/voice";
import {
  type DeserializeContext,
  deserializeSpectrumMessage,
} from "@/webhook/deserialize";
import { slimEnvelopeSchema } from "@/webhook/types";

const PLATFORM = "im";
const UNSUPPORTED_ATTACHMENT_ERROR = /does not support/;

const parse = (raw: unknown) => slimEnvelopeSchema.parse(raw);

const envelope = (content: unknown, overrides: Record<string, unknown> = {}) =>
  parse({
    event: "messages",
    space: { id: "s1", platform: PLATFORM },
    message: {
      id: "m1",
      platform: PLATFORM,
      direction: "inbound",
      timestamp: "2026-06-12T10:00:00.000Z",
      sender: { id: "u1", platform: PLATFORM },
      space: { id: "s1", platform: PLATFORM },
      content,
      ...overrides,
    },
  });

const NO_CTX: DeserializeContext = {};

const deserialize = (content: unknown, ctx: DeserializeContext = NO_CTX) => {
  const result = deserializeSpectrumMessage(envelope(content), ctx);
  if (!result) {
    throw new Error("expected a deserialized message");
  }
  return result;
};

describe("deserializeSpectrumMessage", () => {
  it("resolves the platform and base record fields", () => {
    const { platform, record } = deserialize({ type: "text", text: "hi" });
    expect(platform).toBe(PLATFORM);
    expect(record.id).toBe("m1");
    expect(record.direction).toBe("inbound");
    expect(record.sender).toEqual({ id: "u1", platform: PLATFORM });
    expect(record.space).toMatchObject({ id: "s1", platform: PLATFORM });
    expect(record.timestamp).toEqual(new Date("2026-06-12T10:00:00.000Z"));
  });

  it("falls back to space.platform when message.platform is absent", () => {
    const result = deserializeSpectrumMessage(
      parse({
        event: "messages",
        message: {
          id: "m1",
          space: { id: "s1", platform: PLATFORM },
          content: { type: "text", text: "hi" },
        },
      }),
      NO_CTX
    );
    expect(result?.platform).toBe(PLATFORM);
  });

  it("returns null for an unknown event type", () => {
    const result = deserializeSpectrumMessage(
      parse({
        event: "presence",
        message: {
          id: "m1",
          space: { id: "s1", platform: PLATFORM },
          content: { type: "text", text: "hi" },
        },
      }),
      NO_CTX
    );
    expect(result).toBeNull();
  });

  it("maps text content", () => {
    const { record } = deserialize({ type: "text", text: "hello" });
    expect(record.content).toEqual({ type: "text", text: "hello" });
  });

  it("maps a reaction to a raw text target carrying the contentPreview", () => {
    const { record } = deserialize({
      type: "reaction",
      emoji: "👍",
      target: {
        id: "target-1",
        platform: PLATFORM,
        timestamp: "2026-06-12T09:59:00.000Z",
        sender: { id: "u2", platform: PLATFORM },
        contentPreview: "earlier message",
      },
    });
    const content = record.content as unknown as Reaction;
    expect(content.type).toBe("reaction");
    expect(content.emoji).toBe("👍");
    const target = content.target as unknown as {
      id: string;
      content: { type: string; text: string };
    };
    expect(target.id).toBe("target-1");
    expect(target.content).toEqual({ type: "text", text: "earlier message" });
    // A raw record (no methods) so wrapNestedContent wraps it into a Message.
    expect((target as { react?: unknown }).react).toBeUndefined();
  });

  it("maps a reply to inner content and a raw text target", () => {
    const { record } = deserialize({
      type: "reply",
      content: { type: "text", text: "answer" },
      target: {
        id: "target-1",
        platform: PLATFORM,
        timestamp: "2026-06-12T09:59:00.000Z",
        sender: { id: "u2", platform: PLATFORM },
        contentPreview: "question",
      },
    });
    const content = record.content as unknown as Reply;
    expect(content.type).toBe("reply");
    expect(content.content).toEqual({ type: "text", text: "answer" });
    const target = content.target as unknown as {
      id: string;
      content: { type: string; text: string };
    };
    expect(target.id).toBe("target-1");
    expect(target.content).toEqual({ type: "text", text: "question" });
    expect((target as { react?: unknown }).react).toBeUndefined();
  });

  it("maps a group to raw item records", () => {
    const { record } = deserialize({
      type: "group",
      items: [
        {
          id: "g0",
          sender: { id: "u1" },
          content: { type: "text", text: "a" },
        },
        {
          id: "g1",
          sender: { id: "u1" },
          content: { type: "text", text: "b" },
        },
      ],
    });
    const content = record.content as unknown as {
      type: string;
      items: { id: string; content: { type: string; text: string } }[];
    };
    expect(content.type).toBe("group");
    expect(content.items).toHaveLength(2);
    expect(content.items[0]?.content).toEqual({ type: "text", text: "a" });
    expect(content.items[1]?.id).toBe("g1");
  });

  it("surfaces an inbound richlink as plain text (outbound-only type)", () => {
    const { record } = deserialize({
      type: "richlink",
      url: "https://example.com/post",
    });
    expect(record.content).toEqual({
      type: "text",
      text: "https://example.com/post",
    });
  });

  it("maps a contact's name and phones", () => {
    const { record } = deserialize({
      type: "contact",
      name: { first: "Ada", last: "Lovelace" },
      phones: ["+15550100", { value: "+15550101", type: "work" }],
    });
    const content = record.content as {
      type: string;
      name?: { first?: string; last?: string };
      phones?: { value: string }[];
    };
    expect(content.type).toBe("contact");
    expect(content.name).toEqual({ first: "Ada", last: "Lovelace" });
    expect(content.phones).toEqual([
      { value: "+15550100" },
      { value: "+15550101" },
    ]);
  });

  it("reconstructs attachment bytes via the resolver", async () => {
    const bytes = Buffer.from("attachment-bytes");
    const ctx: DeserializeContext = {
      resolveAttachment: (platform, _spaceRef, attachmentId) => {
        expect(platform).toBe(PLATFORM);
        expect(attachmentId).toBe("att-1");
        return { read: () => Promise.resolve(bytes) };
      },
    };
    const { record } = deserialize(
      {
        type: "attachment",
        id: "att-1",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 16,
      },
      ctx
    );
    const content = record.content as Attachment;
    expect(content.type).toBe("attachment");
    expect(content.name).toBe("photo.jpg");
    expect(content.mimeType).toBe("image/jpeg");
    expect(content.size).toBe(16);
    expect(await content.read()).toEqual(bytes);
  });

  it("delivers attachment metadata with a throwing read() when no resolver exists", async () => {
    const { record } = deserialize({
      type: "attachment",
      id: "att-2",
      name: "doc.pdf",
      mimeType: "application/pdf",
    });
    const content = record.content as Attachment;
    expect(content.name).toBe("doc.pdf");
    expect(content.mimeType).toBe("application/pdf");
    await expect(content.read()).rejects.toThrow(UNSUPPORTED_ATTACHMENT_ERROR);
  });

  it("reconstructs voice bytes and metadata via the attachment resolver", async () => {
    const bytes = Buffer.from("caff-voice-bytes");
    const ctx: DeserializeContext = {
      resolveAttachment: (platform, _spaceRef, attachmentId) => {
        expect(platform).toBe(PLATFORM);
        expect(attachmentId).toBe("voice-att");
        return { read: () => Promise.resolve(bytes) };
      },
    };
    const { record } = deserialize(
      {
        type: "voice",
        id: "voice-att",
        name: "Audio Message.caf",
        mimeType: "audio/x-caf",
        size: 16,
      },
      ctx
    );
    const content = record.content as Voice;
    expect(content.type).toBe("voice");
    expect(content.id).toBe("voice-att");
    expect(content.name).toBe("Audio Message.caf");
    expect(content.mimeType).toBe("audio/x-caf");
    expect(content.size).toBe(16);
    expect(await content.read()).toEqual(bytes);
  });

  it("delivers an unknown content type as custom", () => {
    const { record } = deserialize({ type: "future-thing", foo: "bar" });
    expect(record.content).toEqual({
      type: "custom",
      raw: { type: "future-thing", foo: "bar" },
    });
  });

  it("maps membership content and filters non-string members", () => {
    const added = deserialize({
      type: "addMember",
      members: ["+15550100", 42, "+15550101"],
    });
    expect(added.record.content).toEqual({
      type: "addMember",
      members: ["+15550100", "+15550101"],
    });

    const removed = deserialize({
      type: "removeMember",
      members: ["+15550100"],
    });
    expect(removed.record.content).toEqual({
      type: "removeMember",
      members: ["+15550100"],
    });
  });

  it("degrades membership content with no valid members to custom", () => {
    const { record } = deserialize({ type: "addMember", members: [42] });
    expect(record.content).toEqual({
      type: "custom",
      raw: { type: "addMember", members: [42] },
    });
  });

  it("maps leaveSpace content", () => {
    const { record } = deserialize({ type: "leaveSpace" });
    expect(record.content).toEqual({ type: "leaveSpace" });
  });

  it("maps rename content and degrades an empty displayName to custom", () => {
    const renamed = deserialize({ type: "rename", displayName: "Ski Trip" });
    expect(renamed.record.content).toEqual({
      type: "rename",
      displayName: "Ski Trip",
    });

    const cleared = deserialize({ type: "rename", displayName: "" });
    expect(cleared.record.content).toEqual({
      type: "custom",
      raw: { type: "rename", displayName: "" },
    });
  });

  it("maps an avatar clear action", () => {
    const { record } = deserialize({
      type: "avatar",
      action: { kind: "clear" },
    });
    expect(record.content).toEqual({
      type: "avatar",
      action: { kind: "clear" },
    });
  });

  it("delivers an avatar set as metadata with a throwing read()", async () => {
    const { record } = deserialize({
      type: "avatar",
      action: { kind: "set", mimeType: "image/png" },
    });
    const content = record.content as {
      type: string;
      action: { kind: string; mimeType: string; read: () => Promise<Buffer> };
    };
    expect(content.type).toBe("avatar");
    expect(content.action.kind).toBe("set");
    expect(content.action.mimeType).toBe("image/png");
    await expect(content.action.read()).rejects.toThrow(
      UNSUPPORTED_ATTACHMENT_ERROR
    );
  });

  it("defaults a missing avatar set mimeType", () => {
    const { record } = deserialize({
      type: "avatar",
      action: { kind: "set" },
    });
    const content = record.content as {
      action: { mimeType: string };
    };
    expect(content.action.mimeType).toBe("application/octet-stream");
  });

  it("degrades an unknown avatar action kind to custom", () => {
    const { record } = deserialize({
      type: "avatar",
      action: { kind: "rotate" },
    });
    expect(record.content).toEqual({
      type: "custom",
      raw: { type: "avatar", action: { kind: "rotate" } },
    });
  });
});
