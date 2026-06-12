import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** Current date and time in any IANA timezone — runs locally, no network. */
export const timeTool = createTool({
  id: "get-time",
  description:
    "Get the current date and time in a timezone. Call this when the user asks what time or day it is.",
  inputSchema: z.object({
    timezone: z
      .string()
      .describe('IANA timezone, e.g. "Asia/Tokyo" or "America/Los_Angeles"'),
  }),
  execute: ({ timezone }) =>
    Promise.resolve({
      timezone,
      now: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: timezone,
      }).format(new Date()),
    }),
});
