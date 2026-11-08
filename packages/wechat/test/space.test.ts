import { describe, expect, it } from "vitest";
import { createSpace, resolveUser } from "@/space";

const ZERO_USERS_ERROR = /requires a recipient user/;
const MULTI_USER_ERROR = /group chats are not supported/;

describe("wechat spaces", () => {
  it("resolves a user by id", async () => {
    await expect(
      resolveUser({ input: { userID: "u@im.wechat" } })
    ).resolves.toEqual({ id: "u@im.wechat" });
  });

  it("maps a single user to their 1:1 chat", async () => {
    await expect(
      createSpace({ input: { users: [{ id: "u@im.wechat" }] } })
    ).resolves.toEqual({ id: "u@im.wechat" });
  });

  it("rejects zero users", () => {
    expect(() => createSpace({ input: { users: [] } })).toThrow(
      ZERO_USERS_ERROR
    );
  });

  it("rejects group creation", () => {
    expect(() =>
      createSpace({ input: { users: [{ id: "a" }, { id: "b" }] } })
    ).toThrow(MULTI_USER_ERROR);
  });
});
