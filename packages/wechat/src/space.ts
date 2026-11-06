export interface WeChatSpace {
  id: string;
}

export const resolveUser = ({
  input,
}: {
  input: { userID: string };
}): Promise<{ id: string }> => Promise.resolve({ id: input.userID });

/**
 * A WeChat space is a 1:1 chat, identified by the other user's iLink user id
 * (e.g. `o9cq80…@im.wechat`, as seen on `message.sender.id`). Group chats are
 * not supported in v1.
 */
export const createSpace = ({
  input,
}: {
  input: { users: { id: string }[] };
}): Promise<WeChatSpace> => {
  const [first, ...rest] = input.users;
  if (!first) {
    throw new Error("WeChat space creation requires a recipient user.");
  }
  if (rest.length > 0) {
    throw new Error(
      "WeChat group chats are not supported — create a space with a single user (their 1:1 chat)."
    );
  }
  return Promise.resolve({ id: first.id });
};
