import z from "zod";

export const PLATFORM_NAME = "webChat";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_PATH = "/ai-sdk/chat";
export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface WebChatUser {
  id: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  workspaceId?: string;
}

export const configSchema = z.object({
  auth: z
    .custom<(request: Request) => Promise<WebChatUser> | WebChatUser>(
      (value) => typeof value === "function"
    )
    .optional(),
  concurrency: z
    .object({
      perSpace: z.enum(["queue", "reject", "parallel"]).default("queue"),
    })
    .default({ perSpace: "queue" }),
  responseTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_RESPONSE_TIMEOUT_MS),
  server: z
    .object({
      cors: z
        .object({
          origins: z.array(z.string().min(1)).default([]),
        })
        .default({ origins: [] }),
      host: z.string().min(1).default(DEFAULT_HOST),
      path: z.string().min(1).default(DEFAULT_PATH),
      port: z.number().int().min(0).max(65_535).default(DEFAULT_PORT),
    })
    .default({
      cors: { origins: [] },
      host: DEFAULT_HOST,
      path: DEFAULT_PATH,
      port: DEFAULT_PORT,
    }),
});

export type WebChatConfig = z.infer<typeof configSchema>;
