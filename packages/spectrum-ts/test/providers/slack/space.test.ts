import { describe, expect, it } from "bun:test";
import { slack } from "@/providers/slack";

// Reach the inline def through the provider-config seam — the hooks only
// touch `input`, so the rest of the ctx can be stubbed.
const def = slack.config({ tokens: { T012ABCDE: "jwt" } }).__definition;

const ctx = {
  client: undefined as never,
  config: {} as never,
  store: undefined as never,
};

const TEAM_ID_ERROR = /teamId/;
const MULTI_USER_ERROR = /space\.get/;

describe("slack space.create", () => {
  it("uses the user id as the DM channel", async () => {
    await expect(
      def.space.create({
        ...ctx,
        input: { users: [{ id: "U1" }], params: { teamId: "T1" } },
      })
    ).resolves.toEqual({ id: "U1", teamId: "T1" });
  });

  it("requires a teamId param", async () => {
    await expect(
      def.space.create({ ...ctx, input: { users: [{ id: "U1" }] } })
    ).rejects.toThrow(TEAM_ID_ERROR);
  });

  it("rejects group DMs and points to space.get", async () => {
    await expect(
      def.space.create({
        ...ctx,
        input: {
          users: [{ id: "U1" }, { id: "U2" }],
          params: { teamId: "T1" },
        },
      })
    ).rejects.toThrow(MULTI_USER_ERROR);
  });
});

describe("slack space.get", () => {
  it("returns the channel id with the teamId", async () => {
    await expect(
      def.space.get?.({
        ...ctx,
        input: { id: "C123", params: { teamId: "T1" } },
      })
    ).resolves.toEqual({ id: "C123", teamId: "T1" });
  });

  it("requires a teamId param", async () => {
    await expect(
      def.space.get?.({ ...ctx, input: { id: "C123" } })
    ).rejects.toThrow(TEAM_ID_ERROR);
  });
});
