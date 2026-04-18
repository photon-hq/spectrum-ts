import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Bot } from "grammy";
import { webhookCallback } from "grammy";
import type { TelegramLogger } from "./errors";
import type { WebhookConfig } from "./types";

export interface WebhookServer {
  close: () => Promise<void>;
}

export const startWebhookServer = async (
  bot: Bot,
  config: WebhookConfig & {},
  logger: TelegramLogger
): Promise<WebhookServer> => {
  const handleUpdate = webhookCallback(bot, "http");
  const port = config.port ?? 8443;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (config.secretToken) {
        const token = req.headers["x-telegram-bot-api-secret-token"];
        if (token !== config.secretToken) {
          res.writeHead(403);
          res.end();
          return;
        }
      }

      try {
        await handleUpdate(req, res);
      } catch (err) {
        logger.error("Webhook handler error", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      }
    }
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      logger.info(`Webhook server listening on port ${port}`);
      resolve();
    });
    server.on("error", reject);
  });

  await bot.api.setWebhook(config.url, {
    secret_token: config.secretToken,
  });
  logger.info(`Webhook set to ${config.url}`);

  return {
    close: async () => {
      await bot.api.deleteWebhook();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      logger.info("Webhook server stopped");
    },
  };
};
