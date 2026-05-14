import z from "zod";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";
import { createClient } from "./client";
import { configSchema, PLATFORM_NAME } from "./config";
import { handle, POST } from "./route";
import { oldestOpenSession } from "./session";

// Thin provider entrypoint, mirroring iMessage's pattern: this file wires the
// Spectrum platform contract while request parsing and response sessions live
// in focused modules.
export const vercelAiSdkUI = definePlatform(PLATFORM_NAME, {
  config: configSchema,

  lifecycle: {
    createClient: async () => createClient(),
    destroyClient: async ({ client }) => {
      client.close();
    },
  },

  user: {
    resolve: async ({ input }) => ({
      id: input.userID,
    }),
  },

  space: {
    params: z.object({ id: z.string().optional() }),
    resolve: async ({ config, input }) => ({
      id: input.params?.id ?? config.defaultSpaceId,
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

    const session = oldestOpenSession(client, space.id);
    if (!session) {
      throw new Error(
        `${PLATFORM_NAME}: no active AI SDK UI response session for space "${space.id}"`
      );
    }
    if (!session.writeText(content.text)) {
      throw new Error(
        `${PLATFORM_NAME}: failed to write text to response session for space "${space.id}"`
      );
    }

    // The HTTP stream is the transport; this record lets Spectrum still return
    // a normal outbound Message from space.send(...).
    return {
      id: crypto.randomUUID(),
      content,
      space: { id: space.id },
      timestamp: new Date(),
    };
  },

  static: {
    handle,
    POST,
  },
});
