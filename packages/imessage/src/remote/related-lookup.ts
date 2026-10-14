import {
  AuthenticationError,
  NotFoundError,
  ValidationError,
} from "@photon-ai/advanced-imessage/grpc";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";

const log = createLogger("spectrum.imessage.related");

// gRPC status codes (mirrors `nice-grpc-common` Status), read off
// `IMessageError.grpcCode` because the SDK folds several statuses into one
// error class.
const GRPC_INVALID_ARGUMENT = 3;
const GRPC_PERMISSION_DENIED = 7;

/** What a related lookup was for — used for error messages and logs only. */
export type RelatedLookupKind = "event-target" | "poll" | "reply-target";

/**
 * A related-content lookup (reply target, reaction/read-receipt target, poll
 * metadata) could not establish whether the content is currently visible.
 *
 * Always `retryable: true`, so the stream's `skipUnmappable` rethrows it and
 * `resumableOrderedStream` refetches the event without advancing the cursor
 * instead of delivering stale cached content or permanently dropping the
 * event. Public reads (`space.getMessage`) reject with it. The original
 * upstream failure is kept as `cause`.
 */
export class RelatedContentUnavailableError extends Error {
  readonly retryable = true;
  readonly kind: RelatedLookupKind;
  readonly guid: string;

  constructor(kind: RelatedLookupKind, guid: string, cause: unknown) {
    super(`iMessage ${kind} ${guid} could not be revalidated upstream`, {
      cause,
    });
    this.name = "RelatedContentUnavailableError";
    this.kind = kind;
    this.guid = guid;
  }
}

/** True for any error the stream treats as transient (`retryable: true`). */
export const isRetryableError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { retryable?: unknown }).retryable === true;

/**
 * Upstream definitively says the caller may not see this content: a
 * non-retryable not found (which is also how a hidden message is reported) or
 * a non-retryable PERMISSION_DENIED. The SDK copies `x-retryable` onto every
 * mapped error independently of its class, so a retryable NOT_FOUND is a
 * transient failure, not an absence. `AuthenticationError` also covers
 * UNAUTHENTICATED (an expired/rejected token), which says nothing about this
 * item and is therefore *not* a denial.
 */
export const isRelatedContentDenied = (error: unknown): boolean =>
  !isRetryableError(error) &&
  (error instanceof NotFoundError ||
    (error instanceof AuthenticationError &&
      error.grpcCode === GRPC_PERMISSION_DENIED));

// A non-retryable INVALID_ARGUMENT is the request itself being rejected (a
// malformed guid), not an access decision: retrying would wedge the stream on
// a poison event forever, so it propagates as-is and the stream's existing
// unmappable-event skip applies. No content is surfaced either way.
const isDeterministicRequestRejection = (error: unknown): boolean =>
  error instanceof ValidationError &&
  error.grpcCode === GRPC_INVALID_ARGUMENT &&
  !error.retryable;

const toLookupFailure = (
  kind: RelatedLookupKind,
  guid: string,
  error: unknown
): unknown => {
  if (isRetryableError(error) || isDeterministicRequestRejection(error)) {
    return error;
  }
  // Anything else (UNAUTHENTICATED, a non-retryable transport error, an
  // unclassified server or client error) leaves access unknown. It must not
  // turn into a permanent empty result, so it is promoted to retryable.
  return new RelatedContentUnavailableError(kind, guid, error);
};

/**
 * Run the authoritative upstream lookup for related content. The local
 * assembly caches are never consulted: they cannot observe hidden, reassigned
 * or edited content, so they may store a fresh result but never authorize one.
 *
 * Resolves the upstream value when allowed, `undefined` when upstream
 * definitively denies it (see `isRelatedContentDenied`), and rejects on
 * anything else — retryable unless the request itself was malformed.
 */
export const lookupRelated = async <T>(
  kind: RelatedLookupKind,
  guid: string,
  lookup: () => Promise<T>
): Promise<T | undefined> => {
  try {
    return await lookup();
  } catch (error) {
    if (isRelatedContentDenied(error)) {
      log.debug("related content denied upstream", {
        "spectrum.imessage.related.kind": kind,
        "spectrum.imessage.related.guid": guid,
        ...errorAttrs(error),
      });
      return;
    }
    throw toLookupFailure(kind, guid, error);
  }
};
