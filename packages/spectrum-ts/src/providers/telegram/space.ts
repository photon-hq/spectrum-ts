export interface TelegramSpace {
  id: string;
}

export const resolveUser = ({
  input,
}: {
  input: { userID: string };
}): Promise<{ id: string }> => Promise.resolve({ id: input.userID });

/**
 * Create a space for a Telegram `chat_id`. A bot cannot initiate a
 * conversation or create a group, so creation only works for a private chat:
 * the single recipient's user id equals the chat id. Existing chats (groups,
 * supergroups, channels) are addressed by id via `space.get(chatId)` —
 * Telegram chat ids are numbers in the wire format (negative for
 * groups/supergroups); stringify them with `String(chatId)`.
 */
export const createSpace = ({
  input,
}: {
  input: { users: { id: string }[] };
}): Promise<TelegramSpace> => {
  const [first, ...rest] = input.users;
  if (first && rest.length === 0) {
    return Promise.resolve({ id: first.id });
  }
  if (!first) {
    throw new Error("Telegram space creation requires a recipient user.");
  }
  throw new Error(
    "Telegram bots cannot create group chats — use space.get(chatId) for an existing chat, or create a space with a single user (their private chat)."
  );
};
