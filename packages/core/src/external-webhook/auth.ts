import { cloud } from "../utils/cloud";
import { createTokenRenewal } from "../utils/token-renewal";

export interface EventDeliveryTokenProvider {
  dispose(): Promise<void>;
  getToken(): Promise<string>;
  invalidate(): void;
}

/**
 * Single-token provider for the external webhook stream. Mirrors the renewal cadence
 * of the slack provider package's auth but without per-team bookkeeping —
 * Photon issues one bearer JWT per project.
 */
export function createEventDeliveryTokenProvider(
  projectId: string,
  projectSecret: string
): Promise<EventDeliveryTokenProvider> {
  return (async () => {
    let tokenData = await cloud.issueEventDeliveryToken(
      projectId,
      projectSecret
    );
    const renewal = createTokenRenewal({
      expiresInSeconds: () => tokenData.expiresIn,
      name: "event delivery",
      refresh: async () => {
        tokenData = await cloud.issueEventDeliveryToken(
          projectId,
          projectSecret
        );
      },
    });

    return {
      async getToken(): Promise<string> {
        await renewal.refreshIfNeeded();
        return tokenData.token;
      },
      invalidate(): void {
        renewal.invalidate();
      },
      async dispose(): Promise<void> {
        renewal.dispose();
      },
    };
  })();
}
