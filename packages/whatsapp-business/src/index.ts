import { createClient } from "@photon-ai/whatsapp-business";
import { definePlatform, UnsupportedError } from "@spectrum-ts/core";
import { createCloudClients, disposeCloudAuth } from "./auth";
import { messages, send } from "./messages";
import {
  configSchema,
  isCloudConfig,
  spaceSchema,
  type WhatsAppClients,
} from "./types";

// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export {
  asWhatsAppTemplate,
  isWhatsAppTemplate,
  type WhatsAppTemplate,
  type WhatsAppTemplateInput,
  whatsappTemplate,
  whatsappTemplateSchema,
} from "./content/template";
export { WhatsAppPartialSendError } from "./errors/partial-send";

const PLATFORM_ID = "whatsapp_business";

export const whatsappBusiness = definePlatform(PLATFORM_ID, {
  config: configSchema,

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
    }): Promise<WhatsAppClients> => {
      if (!isCloudConfig(config)) {
        return [
          createClient({
            accessToken: config.accessToken,
            appSecret: config.appSecret ?? "",
            phoneNumberId: config.phoneNumberId,
          }),
        ];
      }

      if (!(projectId && projectSecret)) {
        throw new Error(
          "WhatsApp Business cloud mode requires projectId and projectSecret. " +
            "Either pass credentials to Spectrum(), or provide direct credentials: " +
            "whatsappBusiness.config({ accessToken, phoneNumberId })"
        );
      }

      return await createCloudClients(projectId, projectSecret);
    },

    destroyClient: async ({ client }) => {
      // `disposeCloudAuth` already closes cloud-backed clients, so this pass
      // can double-close them. Teardown is best-effort (the auth helper's own
      // closes use `.catch(() => undefined)` for the same reason) — settle all
      // so one non-idempotent `close()` can't reject and abort cleanup.
      await disposeCloudAuth(client);
      await Promise.allSettled(client.map((c) => c.close()));
    },
  },

  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    create: async ({ input }) => {
      if (input.users.length === 0) {
        throw new Error("WhatsApp space creation requires at least one user");
      }
      if (input.users.length > 1) {
        throw UnsupportedError.action(
          "space.create",
          PLATFORM_ID,
          "only 1:1 conversations are supported"
        );
      }
      const user = input.users[0];
      if (!user) {
        throw new Error("WhatsApp space creation requires a user");
      }
      return { id: user.id };
    },
  },

  messages: ({ client }) => messages(client),

  send: async ({ space, content, client }) =>
    await send(client, space.id, content),
});
