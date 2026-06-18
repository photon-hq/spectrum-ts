import { FUSOR_BRAND, type FusorClient, type FusorVerify } from "./types";

export { type FusorEvent, fusorEvent, isFusorEvent } from "./event";
export type {
  FusorClient,
  FusorMessages,
  FusorMessagesCtx,
  FusorMessagesReturn,
  FusorReply,
  FusorRespond,
  FusorVerify,
  FusorVerifyRequest,
  WebhookHandler,
  WebhookRawRequest,
  WebhookRawResult,
} from "./types";

export function fusor<TPayload>(
  platform: string,
  verify: FusorVerify<TPayload>
): FusorClient<TPayload> {
  return {
    [FUSOR_BRAND]: true,
    platform,
    verify,
  };
}

export function isFusorClient(value: unknown): value is FusorClient {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [FUSOR_BRAND]?: unknown })[FUSOR_BRAND] === true
  );
}
