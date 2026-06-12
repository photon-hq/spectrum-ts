import { getWebhookInfo, setWebhook } from "@photon-ai/telegram-ts";
import { telegramClient } from "./client";
import { TELEGRAM_PLATFORM, type TelegramConfig } from "./config";

/**
 * Base domain of the Fusor "super webhook" edge. Telegram delivers updates to
 * `https://{slug}.{domain}/{platform}`, where Fusor forwards them on to
 * Spectrum. Override per-environment (e.g. `staging.spctrm.dev`) via
 * `SPECTRUM_SUPER_WEBHOOK`.
 */
const DEFAULT_SUPER_WEBHOOK_DOMAIN = "spctrm.dev";

/**
 * The Bot API webhook URL Telegram should POST updates to: the Fusor edge keyed
 * by the project `slug`, on the Telegram platform path segment.
 */
export const webhookUrl = (slug: string): string => {
  const domain =
    process.env.SPECTRUM_SUPER_WEBHOOK ?? DEFAULT_SUPER_WEBHOOK_DOMAIN;
  return `https://${slug}.${domain}/${TELEGRAM_PLATFORM}`;
};

/**
 * Make Telegram deliver this bot's updates to the Fusor edge for `slug`.
 *
 * Idempotent: reads the current webhook via `getWebhookInfo` and only calls
 * `setWebhook` when the URL differs, so a restart with an already-registered
 * bot makes no write. `config.webhookSecret`, when set, is registered as the
 * `secret_token` Telegram echoes back for inbound verification (see `verify`);
 * when absent, the webhook is registered without one.
 *
 * Note: `getWebhookInfo` does not return the secret, so a secret-only change
 * (same URL) is not re-applied — change the URL or clear the webhook to force it.
 *
 * Failures throw a token-free error (the bot token is never interpolated),
 * failing `Spectrum()` startup fast: a bot that cannot register its webhook
 * receives nothing.
 */
export const ensureWebhook = async (
  config: TelegramConfig,
  slug: string
): Promise<void> => {
  const client = telegramClient(config);
  const url = webhookUrl(slug);
  try {
    const info = await getWebhookInfo({ client, throwOnError: true });
    if (info.result?.url === url) {
      return;
    }
    await setWebhook({
      body: {
        url,
        ...(config.webhookSecret ? { secret_token: config.webhookSecret } : {}),
      },
      client,
      throwOnError: true,
    });
  } catch (error) {
    throw new Error(`Telegram webhook registration failed for ${url}`, {
      cause: error,
    });
  }
};
