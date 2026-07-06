import z from "zod";
import type { User } from "../types/user";
import type { ContentBuilder } from "./types";

/**
 * Group-membership management content. Universal content — providers
 * dispatch by `content.type` in their `send` action and decide their own
 * support story (e.g. iMessage only supports it for remote group chats;
 * on a DM it surfaces an `UnsupportedError` telling the caller to create
 * a group via `space.create` instead).
 *
 * `space.send(addMember(users))` is the canonical form; `space.add(...)`,
 * `space.remove(...)`, and `space.leave()` are universal sugar that
 * delegate here. All three are fire-and-forget — no `Message` is produced.
 *
 * Bidirectional: providers also surface platform membership events as
 * inbound `Message`s carrying this content. `message.sender` is the acting
 * user — who added/removed the members — and may be `undefined` when the
 * platform recorded no actor. For `leaveSpace` the sender is the leaver
 * (the content carries no `members`). The agent's own actions are
 * suppressed: `space.add(...)` does not echo back as an inbound event.
 *
 * Members are id strings (or `User`s, normalized to their `id`) in the same
 * platform handle format `space.create` accepts. No async resolution happens
 * in the builder — ids reach the provider verbatim.
 */
export const addMemberSchema = z.object({
  type: z.literal("addMember"),
  members: z
    .array(z.string())
    .min(1, "addMember() requires at least one member"),
});

export type AddMember = z.infer<typeof addMemberSchema>;

export const removeMemberSchema = z.object({
  type: z.literal("removeMember"),
  members: z
    .array(z.string())
    .min(1, "removeMember() requires at least one member"),
});

export type RemoveMember = z.infer<typeof removeMemberSchema>;

export const leaveSpaceSchema = z.object({
  type: z.literal("leaveSpace"),
});

export type LeaveSpace = z.infer<typeof leaveSpaceSchema>;

/** Accepted member input: a `User`, a raw id string, or an array of either. */
export type MemberInput = User | string | (User | string)[];

const toMemberIds = (users: MemberInput): string[] =>
  (Array.isArray(users) ? users : [users]).map((u) =>
    typeof u === "string" ? u : u.id
  );

/**
 * Build an `AddMember` content value inviting `users` into the current
 * group chat. Accepts a single `User` or id string, or an array of either
 * — batches land in one provider call.
 */
export function addMember(users: MemberInput): ContentBuilder {
  return {
    build: async () =>
      addMemberSchema.parse({ type: "addMember", members: toMemberIds(users) }),
  };
}

/**
 * Build a `RemoveMember` content value removing `users` from the current
 * group chat. Accepts the same input shapes as `addMember`.
 */
export function removeMember(users: MemberInput): ContentBuilder {
  return {
    build: async () =>
      removeMemberSchema.parse({
        type: "removeMember",
        members: toMemberIds(users),
      }),
  };
}

/**
 * Build a `LeaveSpace` content value making the agent's own account leave
 * the current group chat.
 */
export function leaveSpace(): ContentBuilder {
  return {
    build: async () => leaveSpaceSchema.parse({ type: "leaveSpace" }),
  };
}
