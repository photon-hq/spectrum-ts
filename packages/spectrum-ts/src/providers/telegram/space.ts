import z from "zod";

export interface TelegramSpace {
  id: string;
}

export const spaceParamsSchema = z.object({
  /**
   * Target a chat directly by id. Telegram chat ids are numbers in the wire
   * format (negative for groups/supergroups); accept either form and store as
   * a string. For a private chat the id equals the user's id.
   */
  chatId: z.union([z.string().min(1), z.number()]).optional(),
});

export type TelegramSpaceParams = z.infer<typeof spaceParamsSchema>;

export const resolveUser = ({
  input,
}: {
  input: { userID: string };
}): Promise<{ id: string }> => Promise.resolve({ id: input.userID });

/**
 * Resolve a space to a Telegram `chat_id`. A bot cannot initiate a conversation
 * or create a group, so a space is always an existing chat: either passed
 * explicitly via `params.chatId`, or — for a private chat — the single
 * recipient's user id (which equals the chat id). Anything else is unsupported.
 */
export const resolveSpace = ({
  input,
}: {
  input: { users: { id: string }[]; params?: TelegramSpaceParams };
}): Promise<TelegramSpace> => {
  const chatId = input.params?.chatId;
  if (chatId !== undefined) {
    return Promise.resolve({ id: String(chatId) });
  }
  const [first, ...rest] = input.users;
  if (first && rest.length === 0) {
    return Promise.resolve({ id: first.id });
  }
  if (!first) {
    throw new Error(
      "Telegram space creation requires params.chatId or a single recipient user."
    );
  }
  throw new Error(
    "Telegram bots cannot create group chats — pass params.chatId for an existing chat, or resolve a single user (their private chat)."
  );
};
