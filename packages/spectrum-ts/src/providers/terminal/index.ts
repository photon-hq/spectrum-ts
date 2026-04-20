import { createInterface } from "node:readline";
import z from "zod";
import { definePlatform } from "../../platform/define";

export const terminal = definePlatform("terminal", {
  config: z.object({}),

  user: {
    resolve: async ({ input }) => ({
      id: input.userID,
    }),
  },

  space: {
    resolve: async () => ({
      id: "terminal",
    }),
  },

  lifecycle: {
    createClient: async () => {
      const client = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      client.on("SIGINT", () => {
        client.close();
        process.kill(process.pid, "SIGINT");
      });

      return client;
    },

    destroyClient: async ({ client }) => {
      client.close();
      process.stdin.unref();
    },
  },

  events: {
    async *messages({ client }) {
      for await (const line of client) {
        yield {
          id: crypto.randomUUID(),
          content: { type: "text" as const, text: line },
          sender: { id: "terminal-user" },
          space: { id: "terminal" },
          timestamp: new Date(),
        };
      }
    },
  },

  actions: {
    send: async ({ content }) => {
      if (content.type !== "text") {
        throw new Error(
          `Terminal provider only supports text content, got "${content.type}"`
        );
      }
      console.log(content.text);
      return { id: crypto.randomUUID(), timestamp: new Date() };
    },
  },
});
