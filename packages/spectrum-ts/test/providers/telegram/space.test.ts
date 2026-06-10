import { describe, expect, it } from "bun:test";
import { createSpace } from "@/providers/telegram/space";

const ZERO_USERS_ERROR = /requires a recipient user/;
const MULTI_USER_ERROR = /space\.get\(chatId\)/;

describe("telegram createSpace", () => {
  it("maps a single user to their private chat id", async () => {
    await expect(
      createSpace({ input: { users: [{ id: "42" }] } })
    ).resolves.toEqual({ id: "42" });
  });

  it("rejects zero users", () => {
    expect(() => createSpace({ input: { users: [] } })).toThrow(
      ZERO_USERS_ERROR
    );
  });

  it("rejects multi-user creation and points to space.get", () => {
    expect(() =>
      createSpace({ input: { users: [{ id: "1" }, { id: "2" }] } })
    ).toThrow(MULTI_USER_ERROR);
  });
});
