import { describe, expect, it } from "bun:test";
import { configSchema } from "@/providers/discord/config";
import { handleMessages } from "@/providers/discord/inbound/messages";
import { DispatchEvent } from "@/providers/discord/types";

// applicationId "999" is the bot's own id — drives the self-event filters.
const config = configSchema.parse({
  botToken: "abc.def.ghi",
  applicationId: "999",
});

// `handleMessages` is a Fusor handler; it only reads `payload` + `config`, so a
// minimal ctx (cast to the full ctx type) is enough to exercise it.
const handle = (t: string, d: Record<string, unknown>) =>
  handleMessages({
    config,
    payload: { t, d },
  } as Parameters<typeof handleMessages>[0]);

const reactionPayload = (over: Record<string, unknown> = {}) => ({
  channel_id: "100",
  message_id: "5",
  user_id: "7",
  emoji: { id: null, name: "👍" },
  ...over,
});

describe("handleMessages — MESSAGE_DELETE", () => {
  it("maps a delete to an unsend retracting the message", () => {
    const record = handle(DispatchEvent.MESSAGE_DELETE, {
      id: "5",
      channel_id: "100",
    });
    expect(record?.id).toBe("delete:100:5");
    expect(record?.space.id).toBe("100");
    expect(record?.content.type).toBe("unsend");
    if (record?.content.type === "unsend") {
      expect(record.content.target.id).toBe("5");
      expect(record.content.target.direction).toBe("inbound");
    }
  });
});

describe("handleMessages — MESSAGE_REACTION_REMOVE", () => {
  it("maps a reaction removal to an unsend targeting the reaction", () => {
    const record = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload()
    );
    expect(record?.id).toBe("reaction-remove:100:5:7:👍");
    expect(record?.sender?.id).toBe("7");
    expect(record?.space.id).toBe("100");
    expect(record?.content.type).toBe("unsend");
  });

  it("targets the same id the add handler synthesizes so they correlate", () => {
    const added = handle(DispatchEvent.MESSAGE_REACTION_ADD, reactionPayload());
    const removed = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload()
    );
    expect(added?.id).toBe("reaction:100:5:7:👍");
    expect(removed?.content.type).toBe("unsend");
    if (removed?.content.type === "unsend") {
      expect(removed.content.target.id).toBe("reaction:100:5:7:👍");
    }
  });

  it("ignores the bot's own reaction removals", () => {
    const record = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload({ user_id: "999" })
    );
    expect(record).toBeUndefined();
  });

  it("ignores custom emoji with no name", () => {
    const record = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload({ emoji: { id: "123", name: null } })
    );
    expect(record).toBeUndefined();
  });
});
