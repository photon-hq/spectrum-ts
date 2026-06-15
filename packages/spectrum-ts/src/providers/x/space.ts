export interface XSpace {
  id: string;
}

export const resolveUser = ({
  input,
}: {
  input: { userID: string };
}): Promise<{ id: string }> => Promise.resolve({ id: input.userID });

/**
 * Create a 1:1 DM space by recipient user id.
 *
 * Group DM creation is intentionally out of scope for v1.
 */
export const createSpace = ({
  input,
}: {
  input: { users: { id: string }[] };
}): Promise<XSpace> => {
  const [first, ...rest] = input.users;
  if (first && rest.length === 0) {
    return Promise.resolve({ id: first.id });
  }
  if (!first) {
    throw new Error("X space creation requires a recipient user.");
  }
  throw new Error(
    "X v1 provider supports 1:1 DMs only — pass exactly one recipient user."
  );
};
