import {
  EXTERNAL_WEBHOOK_BRAND,
  type ExternalWebhookClient,
  type ExternalWebhookVerify,
} from "./types";

export { isProviderEvent, type ProviderEvent, providerEvent } from "./event";
export type {
  ExternalWebhookClient,
  ExternalWebhookMessages,
  ExternalWebhookMessagesCtx,
  ExternalWebhookMessagesReturn,
  ExternalWebhookReply,
  ExternalWebhookRespond,
  ExternalWebhookVerify,
  ExternalWebhookVerifyRequest,
  WebhookHandler,
  WebhookRawRequest,
  WebhookRawResult,
} from "./types";

export function webhookClient<TPayload>(
  platform: string,
  verify: ExternalWebhookVerify<TPayload>
): ExternalWebhookClient<TPayload> {
  return {
    [EXTERNAL_WEBHOOK_BRAND]: true,
    platform,
    verify,
  };
}

export function isExternalWebhookClient(
  value: unknown
): value is ExternalWebhookClient {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [EXTERNAL_WEBHOOK_BRAND]?: unknown })[
      EXTERNAL_WEBHOOK_BRAND
    ] === true
  );
}
