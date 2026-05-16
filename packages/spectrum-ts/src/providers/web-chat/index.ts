import z from "zod";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";
import { createClient } from "./client";
import { configSchema, PLATFORM_NAME } from "./config";

const webChatSpaceSchema = z.object({
  agentId: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  requestId: z.string().min(1),
  submittedMessageId: z.string().min(1),
  userId: z.string().min(1),
});

/**
 * Spectrum provider for browser chat requests that speak the AI SDK UI stream
 * protocol at the boundary while preserving Spectrum's normal provider model:
 * inbound `messages()` plus outbound `send(...)`.
 */
export const webChat = definePlatform(PLATFORM_NAME, {
  config: configSchema,

  lifecycle: {
    createClient,
    destroyClient: async ({ client }) => {
      await client.close();
    },
  },

  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    params: webChatSpaceSchema,
    schema: webChatSpaceSchema,
    resolve: async ({ input }) => webChatSpaceSchema.parse(input.params),
  },

  async *messages({ client }) {
    for await (const message of client.inbound.iter) {
      yield message;
    }
  },

  send: async ({ client, content, space }) => {
    if (content.type === "typing") {
      return;
    }
    if (content.type !== "text") {
      throw UnsupportedError.content(content.type, PLATFORM_NAME);
    }
    if (typeof space.requestId !== "string") {
      throw new Error(
        `${PLATFORM_NAME}: missing requestId on space "${space.id}"`
      );
    }

    // Match by request id, not only space id. A single conversation can have
    // retries or overlapping browser requests; request-scoped routing prevents
    // response chunks from crossing into the wrong stream.
    const session = client.pendingByRequestId.get(space.requestId);
    if (!session) {
      throw new Error(
        `${PLATFORM_NAME}: no active webChat response session "${space.requestId}"`
      );
    }
    if (!session.writeText(content.text)) {
      throw new Error(
        `${PLATFORM_NAME}: failed to write text to response session "${space.requestId}"`
      );
    }

    return {
      id: crypto.randomUUID(),
      content,
      space,
      timestamp: new Date(),
    };
  },
});
