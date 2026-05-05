import { createClient, type VoiceClient } from "@photon-ai/voice-ts";
import z from "zod";
import { definePlatform } from "../../platform/define";
import { cloud } from "../../utils/cloud";
import { UnsupportedError } from "../../utils/errors";

const PLATFORM = "voice";
const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const RENEWAL_FLOOR_MS = 5000;

// Bridges the renewal closure in createVoiceClient to destroyClient, which
// only sees the bare VoiceClient.
const disposers = new WeakMap<VoiceClient, () => void>();

const createVoiceClient = async (
  projectId: string,
  projectSecret: string
): Promise<VoiceClient> => {
  let tokenData = await cloud.issueVoiceTokens(projectId, projectSecret);
  let expiresAt = Date.now() + tokenData.expiresIn * 1000;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < expiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    tokenData = await cloud.issueVoiceTokens(projectId, projectSecret);
    expiresAt = Date.now() + tokenData.expiresIn * 1000;
  };

  const scheduleRenewal = (): void => {
    if (disposed) {
      return;
    }
    const ms = Math.max(
      tokenData.expiresIn * 1000 * RENEWAL_RATIO,
      RENEWAL_FLOOR_MS
    );
    timer = setTimeout(async () => {
      try {
        await refreshIfNeeded();
        scheduleRenewal();
      } catch (err) {
        console.warn(
          `[spectrum-ts] voice token refresh failed; retrying in ${RETRY_DELAY_MS}ms.`,
          err
        );
        timer = setTimeout(scheduleRenewal, RETRY_DELAY_MS);
        timer?.unref?.();
      }
    }, ms);
    timer?.unref?.();
  };

  scheduleRenewal();

  const client = createClient({
    token: async () => {
      await refreshIfNeeded();
      return tokenData.token;
    },
  });

  disposers.set(client, () => {
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });

  return client;
};

export const voice = definePlatform(PLATFORM, {
  config: z.object({}).strict(),

  lifecycle: {
    createClient: async ({
      projectId,
      projectSecret,
    }): Promise<VoiceClient> => {
      if (!(projectId && projectSecret)) {
        throw new Error(
          "voice provider requires projectId and projectSecret. Pass credentials to Spectrum({ projectId, projectSecret })."
        );
      }
      return await createVoiceClient(projectId, projectSecret);
    },

    destroyClient: async ({ client }: { client: VoiceClient }) => {
      disposers.get(client)?.();
      disposers.delete(client);
      await client.close();
    },
  },

  user: {
    resolve: ({ input }) => Promise.resolve({ id: input.userID }),
  },

  space: {
    resolve: ({ input }) => {
      const user = input.users[0];
      if (!user) {
        throw new Error("voice space requires at least one user");
      }
      return Promise.resolve({ id: user.id });
    },
  },

  events: {
    // biome-ignore lint/correctness/useYield: stub that throws before any yield
    async *messages() {
      throw UnsupportedError.action(
        "subscribe to messages",
        PLATFORM,
        "voice events are not yet implemented"
      );
    },
  },

  actions: {
    send: () => {
      throw UnsupportedError.action(
        "send",
        PLATFORM,
        "voice send is not yet implemented"
      );
    },
  },
});
