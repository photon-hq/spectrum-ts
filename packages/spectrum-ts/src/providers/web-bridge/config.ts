import z from "zod";

export const PLATFORM_NAME = "web-bridge";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
export const DEFAULT_ENDPOINT = "/spectrum/web/messages";

export const bridgeRequestSchema = z.object({
  messageId: z.string().min(1),
  metadata: z.unknown().optional(),
  requestId: z.string().min(1),
  responseSessionId: z.string().min(1),
  spaceId: z.string().min(1),
  text: z.string().min(1),
  userId: z.string().min(1),
});

export const configSchema = z.object({
  responseTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_RESPONSE_TIMEOUT_MS),
  server: z
    .object({
      apiKey: z.string().min(1).optional(),
      endpoint: z.string().min(1).default(DEFAULT_ENDPOINT),
      host: z.string().min(1).default(DEFAULT_HOST),
      port: z.number().int().min(0).max(65_535).default(DEFAULT_PORT),
    })
    .default({
      endpoint: DEFAULT_ENDPOINT,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
    }),
});

export type WebBridgeConfig = z.infer<typeof configSchema>;
export type WebBridgeRequest = z.infer<typeof bridgeRequestSchema>;
