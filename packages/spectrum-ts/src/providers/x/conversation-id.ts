const INTERNAL_SEPARATOR = ":";

/**
 * Build a stable internal conversation id from two participant user ids.
 * Sorts ids so `a:b` and `b:a` resolve to the same value.
 */
export const buildInternalConversationId = (
  senderId: string,
  recipientId: string
): string => {
  const sorted = [senderId, recipientId].sort();
  const [left, right] = sorted;
  return `${left}${INTERNAL_SEPARATOR}${right}`;
};

/**
 * Normalize an X conversation id to the internal `a:b` form. Accepts existing
 * internal ids and X's hyphen-separated `a-b` format from the REST API.
 */
export const normalizeXConversationIdToInternal = (
  dmConversationId: string
): string => {
  const trimmed = dmConversationId.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.includes(INTERNAL_SEPARATOR)) {
    const [a, b] = trimmed.split(INTERNAL_SEPARATOR);
    if (a && b) {
      return buildInternalConversationId(a, b);
    }
    return trimmed;
  }

  const [first, second] = trimmed.split("-");
  if (first && second) {
    return buildInternalConversationId(first, second);
  }

  return trimmed;
};
