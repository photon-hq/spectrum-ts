import type { UIMessage } from "ai";

/**
 * Minimal authenticated user shape passed through the request-scoped adapter.
 *
 * Applications can extend this with their own claims by parameterizing
 * `createSpectrumChatHandler<User>()`; the adapter only requires a stable id.
 */
export interface SpectrumChatUser {
  id: string;
  [key: string]: unknown;
}

/**
 * Context passed to the developer's `respond(...)` callback.
 *
 * This object keeps AI SDK UI request data at the HTTP boundary while giving
 * server code enough Spectrum-compatible context to produce one response for
 * the current request.
 */
export interface SpectrumChatRespondContext<
  User extends SpectrumChatUser = SpectrumChatUser,
> {
  conversationId: string;
  message: UIMessage;
  messages: UIMessage[];
  metadata: unknown;
  request: Request;
  requestId: string;
  signal: AbortSignal;
  spaceId: string;
  text: string;
  user: User;
}

/**
 * Supported response shapes for Phase 2A.
 *
 * A string is written as one AI SDK text delta; an async iterable is streamed
 * chunk-by-chunk until completion or request abort.
 */
export type SpectrumChatResponderResult =
  | AsyncIterable<string>
  | Promise<AsyncIterable<string> | string>
  | string;

/**
 * Configuration for `createSpectrumChatHandler(...)`.
 *
 * `getUser` is optional for prototypes; production routes should use it to
 * authenticate the request before user text reaches application code.
 */
export interface CreateSpectrumChatHandlerOptions<
  User extends SpectrumChatUser = SpectrumChatUser,
> {
  // Auth belongs at the HTTP boundary for this adapter. Returning null
  // rejects the request before any user content reaches respond(...).
  getUser?: (request: Request) => Promise<User | null> | User | null;
  respond: (
    context: SpectrumChatRespondContext<User>
  ) => SpectrumChatResponderResult;
}
