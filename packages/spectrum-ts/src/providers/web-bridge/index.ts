import z from "zod";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";
import { createClient } from "./client";
import { configSchema, PLATFORM_NAME } from "./config";

/**
 * Long-running HTTP provider for routing web chat requests through Spectrum.
 *
 * Use this in a worker process alongside persistent providers such as terminal,
 * iMessage, or WhatsApp. The provider starts its HTTP server during Spectrum's
 * lifecycle and routes `space.send("text")` back to the exact HTTP request
 * identified by `space.responseSessionId`.
 */
export const webBridge = definePlatform(PLATFORM_NAME, {
  config: configSchema,

  lifecycle: {
    createClient,
    destroyClient: async ({ client }) => {
      await client.close();
    },
  },

  user: {
    resolve: async ({ input }) => ({
      id: input.userID,
    }),
  },

  space: {
    params: z.object({
      id: z.string().min(1),
      messageId: z.string().min(1).optional(),
      requestId: z.string().min(1).optional(),
      responseSessionId: z.string().min(1).optional(),
      userId: z.string().min(1).optional(),
    }),
    schema: z.object({
      id: z.string().min(1),
      messageId: z.string().min(1).optional(),
      requestId: z.string().min(1).optional(),
      responseSessionId: z.string().min(1).optional(),
      userId: z.string().min(1).optional(),
    }),
    resolve: async ({ input }) => ({
      ...input.params,
      id: input.params?.id ?? "web-bridge",
    }),
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
    if (typeof space.responseSessionId !== "string") {
      throw new Error(
        `${PLATFORM_NAME}: missing responseSessionId on space "${space.id}"`
      );
    }

    const session = client.pendingByResponseSessionId.get(
      space.responseSessionId
    );
    if (!session) {
      throw new Error(
        `${PLATFORM_NAME}: no active response session "${space.responseSessionId}"`
      );
    }
    if (!session.writeText(content.text)) {
      throw new Error(
        `${PLATFORM_NAME}: failed to write text to response session "${space.responseSessionId}"`
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
