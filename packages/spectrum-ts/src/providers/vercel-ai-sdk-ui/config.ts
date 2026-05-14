import z from "zod";

// Shared provider constants and config schema. Keeping these together avoids
// hard-coded platform names/status codes across route, session, and index code.
export const PLATFORM_NAME = "vercel-ai-sdk-ui";
export const DEFAULT_USER_ID = "web-user";
export const DEFAULT_SPACE_ID = "default";
export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
export const BAD_REQUEST_STATUS = 400;
export const CLIENT_CLOSED_REQUEST_STATUS = 499;

export const configSchema = z.object({
  defaultUserId: z.string().min(1).default(DEFAULT_USER_ID),
  defaultSpaceId: z.string().min(1).default(DEFAULT_SPACE_ID),
  responseTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_RESPONSE_TIMEOUT_MS),
  closeOnFirstTextSend: z.boolean().default(true),
});

export type VercelAiSdkUIConfig = z.infer<typeof configSchema>;
