import { type FusorClient, fusor } from "../../fusor";
import { definePlatform } from "../../platform/define";
import { configSchema, hasRefreshCreds, X_PLATFORM } from "./config";
import { createDirectAuth, getDirectAuth } from "./direct-auth";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { createSpace, resolveUser } from "./space";
import type { XPayload } from "./types";
import { verify } from "./verify";

export type { XConfig, XDirectConfig } from "./config";
// biome-ignore lint/performance/noBarrelFile: provider entrypoint re-exports webhook helpers
export { ensureWebhook, webhookUrl } from "./webhook";

/**
 * X provider for Spectrum (BYO-app).
 *
 * The customer brings their own X app. Inbound rides the Fusor edge
 * (`{slug}.spctrm.dev/x`): `verify` answers CRC + checks the X signature with
 * the customer's consumer secret, and `messages` maps DM webhooks to provider
 * records. Outbound sends text and media DMs through the X REST API (chunked
 * upload for attachments; one media item plus optional caption per DM).
 *
 * At launch the SDK registers the Fusor webhook with the customer's app bearer
 * and, when OAuth refresh creds are supplied, keeps the access token fresh via
 * a local refresh sidecar — no Spectrum-managed X credentials are involved.
 */
export const x = definePlatform(X_PLATFORM, {
  config: configSchema,
  lifecycle: {
    createClient: async ({ config, store }): Promise<FusorClient<XPayload>> => {
      // SDK-side refresh: stand up the local token sidecar so the access token
      // stays fresh (and rotates) using the customer's own OAuth app.
      if (hasRefreshCreds(config)) {
        await createDirectAuth({ config, store });
      }
      // Webhook registration is intentionally NOT done here. Creating the X
      // webhook triggers X's synchronous CRC, which is answered by
      // `app.webhook()` — so registration must happen only AFTER the webhook
      // server is listening. The app calls the exported `ensureWebhook` once its
      // server is up.
      return fusor<XPayload>(X_PLATFORM, verify(config));
    },
    destroyClient: ({ store }) => {
      getDirectAuth(store)?.dispose();
      return Promise.resolve();
    },
  },
  user: { resolve: resolveUser },
  space: { create: createSpace },
  messages: handleMessages,
  send,
});
