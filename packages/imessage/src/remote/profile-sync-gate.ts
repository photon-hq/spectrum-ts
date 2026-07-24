import { cloud, type ProjectData } from "@spectrum-ts/core";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";
import type { IMessageClient } from "../types";

const PROFILE_SYNC_CACHE_TTL_MS = 60_000;
const PROFILE_SYNC_RETRY_DELAY_MS = 30_000;

const log = createLogger("spectrum.imessage.profile-sync");

export interface ProfileSyncGate {
  dispose(): void;
  isEnabled(): Promise<boolean>;
}

interface ProfileSyncGateOptions {
  cacheTtlMs?: number;
  initialEnabled: boolean;
  refresh: () => Promise<boolean>;
  retryDelayMs?: number;
}

export const createProfileSyncGate = (
  options: ProfileSyncGateOptions
): ProfileSyncGate => {
  const cacheTtlMs = options.cacheTtlMs ?? PROFILE_SYNC_CACHE_TTL_MS;
  const retryDelayMs = options.retryDelayMs ?? PROFILE_SYNC_RETRY_DELAY_MS;
  let cachedEnabled = options.initialEnabled;
  let disposed = false;
  let refreshInFlight: Promise<boolean> | undefined;
  let retryAfter = 0;
  let validUntil = Date.now() + cacheTtlMs;

  const refreshNow = async (): Promise<boolean> => {
    try {
      const enabled = await options.refresh();
      if (disposed) {
        return false;
      }
      cachedEnabled = enabled;
      retryAfter = 0;
      validUntil = Date.now() + cacheTtlMs;
      return enabled;
    } catch (error) {
      cachedEnabled = false;
      retryAfter = Date.now() + retryDelayMs;
      validUntil = 0;
      log.warn(
        "failed to refresh profile sync state; automatic contact sharing remains disabled",
        {
          "spectrum.imessage.profile_sync.retry_in_ms": retryDelayMs,
          ...errorAttrs(error),
        },
        error
      );
      return false;
    }
  };

  const coalescedRefresh = (): Promise<boolean> => {
    if (!refreshInFlight) {
      refreshInFlight = refreshNow().finally(() => {
        refreshInFlight = undefined;
      });
    }
    return refreshInFlight;
  };

  return {
    dispose(): void {
      disposed = true;
      cachedEnabled = false;
      validUntil = 0;
    },
    async isEnabled(): Promise<boolean> {
      if (disposed) {
        return false;
      }

      const now = Date.now();
      if (now < validUntil) {
        return cachedEnabled;
      }
      if (now < retryAfter) {
        return false;
      }
      return await coalescedRefresh();
    },
  };
};

const gates = new WeakMap<IMessageClient, ProfileSyncGate>();

const isProfileSynced = (projectConfig: ProjectData): boolean =>
  projectConfig.profile?.imessageSynced === true;

export const registerProfileSyncGate = (
  clients: IMessageClient,
  projectId: string,
  projectSecret: string,
  projectConfig: ProjectData
): void => {
  const previous = gates.get(clients);
  previous?.dispose();

  gates.set(
    clients,
    createProfileSyncGate({
      initialEnabled: isProfileSynced(projectConfig),
      refresh: async () =>
        isProfileSynced(await cloud.getProject(projectId, projectSecret)),
    })
  );
};

export const getProfileSyncGate = (
  clients: IMessageClient
): ProfileSyncGate | undefined => gates.get(clients);

export const disposeProfileSyncGate = (clients: IMessageClient): void => {
  const gate = gates.get(clients);
  gate?.dispose();
  gates.delete(clients);
};
