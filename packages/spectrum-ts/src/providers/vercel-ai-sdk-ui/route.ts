import { asText } from "../../content/text";
import type { PlatformRuntime, SpectrumLike } from "../../platform/types";
import type { VercelAiSdkUIClient } from "./client";
import {
  BAD_REQUEST_STATUS,
  CLIENT_CLOSED_REQUEST_STATUS,
  PLATFORM_NAME,
  type VercelAiSdkUIConfig,
} from "./config";
import { parseChatRequest } from "./request";
import { addSession } from "./session";

// Route helpers are the public bridge for Next.js/Vercel handlers. They turn a
// useChat POST into one inbound Spectrum message and keep the Response open for
// the matching space.send(...) text reply.
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: BAD_REQUEST_STATUS });
}

function getRuntime(app: SpectrumLike): PlatformRuntime {
  const runtime = app.__internal.platforms.get(PLATFORM_NAME);
  if (!runtime) {
    throw new Error(`Platform "${PLATFORM_NAME}" is not registered`);
  }
  return runtime;
}

async function loadAiRuntime(): Promise<typeof import("ai")> {
  try {
    return await import("ai");
  } catch (cause) {
    throw new Error(
      'The Vercel AI SDK UI provider requires the optional peer dependency "ai". Install it before calling vercelAiSdkUI.handle() or vercelAiSdkUI.POST().',
      { cause }
    );
  }
}

export async function handle(
  app: SpectrumLike,
  req: Request
): Promise<Response> {
  const runtime = getRuntime(app);
  const client = runtime.client as VercelAiSdkUIClient;
  const config = runtime.config as VercelAiSdkUIConfig;

  if (req.signal.aborted) {
    return Response.json(
      { error: "Request was aborted." },
      { status: CLIENT_CLOSED_REQUEST_STATUS }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const parsed = parseChatRequest(body, config);
  if ("error" in parsed) {
    return badRequest(parsed.error);
  }

  const { createUIMessageStream, createUIMessageStreamResponse } =
    await loadAiRuntime();
  const session = addSession(client, config, parsed.spaceId, req.signal);
  const stream = createUIMessageStream({
    execute({ writer }) {
      session.attach(writer);
      return session.done;
    },
  });

  client.inbound.push({
    id: parsed.id,
    content: asText(parsed.text),
    sender: { id: parsed.userId },
    space: { id: parsed.spaceId },
    timestamp: new Date(),
  });

  return createUIMessageStreamResponse({ stream });
}

export function POST(app: SpectrumLike): (req: Request) => Promise<Response> {
  return (req: Request) => handle(app, req);
}
