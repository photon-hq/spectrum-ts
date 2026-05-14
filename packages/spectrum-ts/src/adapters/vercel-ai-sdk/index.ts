import {
  defaultChatUser,
  isSpectrumChatUser,
  parseChatRequest,
  spaceIdForUser,
} from "./request";
import { isAsyncIterable, loadAiRuntime, writeResponseText } from "./stream";
import type {
  CreateSpectrumChatHandlerOptions,
  SpectrumChatUser,
} from "./types";

export type {
  CreateSpectrumChatHandlerOptions,
  CreateSpectrumWorkerBridgeOptions,
  SpectrumChatRespondContext,
  SpectrumChatResponderResult,
  SpectrumChatUser,
} from "./types";

// biome-ignore lint/performance/noBarrelFile: adapter aggregate entrypoint
export { createSpectrumWorkerBridge } from "./worker";

const BAD_REQUEST_STATUS = 400;
const CLIENT_CLOSED_REQUEST_STATUS = 499;
const INTERNAL_SERVER_ERROR_STATUS = 500;
const UNAUTHORIZED_STATUS = 401;

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: BAD_REQUEST_STATUS });
}

function internalServerError(message: string): Response {
  return Response.json(
    { error: message },
    { status: INTERNAL_SERVER_ERROR_STATUS }
  );
}

/**
 * Creates a request-scoped Vercel AI SDK `useChat` route handler.
 *
 * The returned function is safe to export as a Next.js `POST` handler because
 * it handles exactly one HTTP request and returns exactly one streamed AI SDK
 * UI response. It intentionally does not start `Spectrum()`, `app.messages`,
 * provider listeners, or any persistent loop.
 *
 * This is a Spectrum-compatible web handler, not the full "Vercel as another
 * Spectrum provider" runtime. Full iMessage, WhatsApp, terminal, and gRPC
 * support still belongs in a separate long-running worker bridge.
 */
export function createSpectrumChatHandler<
  User extends SpectrumChatUser = SpectrumChatUser,
>(
  options: CreateSpectrumChatHandlerOptions<User>
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.signal.aborted) {
      return Response.json(
        { error: "Request was aborted." },
        { status: CLIENT_CLOSED_REQUEST_STATUS }
      );
    }

    const user = options.getUser
      ? await options.getUser(request)
      : (defaultChatUser() as User);
    if (user === null) {
      return Response.json(
        { error: "Unauthorized." },
        { status: UNAUTHORIZED_STATUS }
      );
    }
    if (!isSpectrumChatUser(user)) {
      return internalServerError(
        "getUser(request) must return a user object with a non-empty string id."
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Request body must be valid JSON.");
    }

    const parsed = parseChatRequest(body);
    if ("error" in parsed) {
      return badRequest(parsed.error);
    }

    const spaceId = spaceIdForUser(user, parsed.conversationId);
    const { createUIMessageStream, createUIMessageStreamResponse } =
      await loadAiRuntime();
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = await options.respond({
          conversationId: parsed.conversationId,
          message: parsed.message,
          messages: parsed.messages,
          metadata: parsed.metadata,
          request,
          requestId: parsed.requestId,
          signal: request.signal,
          spaceId,
          text: parsed.text,
          user,
        });

        if (!(typeof result === "string" || isAsyncIterable(result))) {
          throw new Error(
            "createSpectrumChatHandler respond() must return a string or AsyncIterable<string>."
          );
        }

        await writeResponseText({
          id: `${parsed.requestId}-text`,
          result,
          signal: request.signal,
          writer,
        });
      },
    });

    return createUIMessageStreamResponse({ stream });
  };
}
