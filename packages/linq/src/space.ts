import z from "zod";
import type { LinqConfig } from "./config";
import type { ServiceType } from "./types";

/**
 * A new chat can't be created without an initial message (LinQ's `POST /chats`
 * requires one), so when a space is built from recipients alone we defer
 * creation: `space.id` holds a marker encoding `from` + recipients, and the
 * first message-producing `send` calls `createChat` and caches the real id.
 */
export const PENDING_PREFIX = "linq:pending:";
const PENDING_SEPARATOR = "::";

export interface LinqSpace {
  id: string;
  preferredService?: ServiceType;
}

export const spaceParamsSchema = z.object({
  /** Target an existing LinQ chat directly by id. */
  chatId: z.string().min(1).optional(),
  /** Sending number for a newly-created chat (falls back to config.defaultFrom). */
  from: z.string().min(1).optional(),
  /** Force a delivery protocol for this conversation. */
  preferredService: z.enum(["iMessage", "SMS", "RCS"]).optional(),
});

export type LinqSpaceParams = z.infer<typeof spaceParamsSchema>;

const encodePending = (from: string, to: string[]): string =>
  `${PENDING_PREFIX}${from}${PENDING_SEPARATOR}${to.join(",")}`;

export const decodePending = (
  id: string
): { from: string; to: string[] } | undefined => {
  if (!id.startsWith(PENDING_PREFIX)) {
    return;
  }
  const body = id.slice(PENDING_PREFIX.length);
  const sepIndex = body.indexOf(PENDING_SEPARATOR);
  if (sepIndex === -1) {
    return;
  }
  const from = body.slice(0, sepIndex);
  const toJoined = body.slice(sepIndex + PENDING_SEPARATOR.length);
  return { from, to: toJoined ? toJoined.split(",") : [] };
};

export const resolveUser = ({
  input,
}: {
  input: { userID: string };
}): Promise<{ id: string }> => Promise.resolve({ id: input.userID });

export const resolveSpace = ({
  input,
  config,
}: {
  input: { users: { id: string }[]; params?: LinqSpaceParams };
  config: LinqConfig;
}): Promise<LinqSpace> => {
  const params = input.params;
  if (params?.chatId) {
    return Promise.resolve({
      id: params.chatId,
      ...(params.preferredService
        ? { preferredService: params.preferredService }
        : {}),
    });
  }
  const from = params?.from ?? config.defaultFrom;
  if (!from) {
    throw new Error(
      "LinQ space creation requires a sending number — set config.defaultFrom, pass params.from, or pass params.chatId for an existing chat."
    );
  }
  const to = input.users.map((user) => user.id);
  if (to.length === 0) {
    throw new Error("LinQ space creation requires at least one recipient.");
  }
  return Promise.resolve({
    id: encodePending(from, to),
    ...(params?.preferredService
      ? { preferredService: params.preferredService }
      : {}),
  });
};
