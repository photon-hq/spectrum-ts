import { cloud } from "../utils/cloud";
import { createTokenRenewal } from "../utils/token-renewal";

export interface FusorTokenProvider {
  dispose(): Promise<void>;
  getToken(): Promise<string>;
  invalidate(): void;
}

/**
 * Single-token provider for the fusor stream. Mirrors the renewal cadence
 * of the slack provider package's auth but without per-team bookkeeping —
 * fusor issues one bearer JWT per project.
 */
export function createFusorTokenProvider(
  projectId: string,
  projectSecret: string
): Promise<FusorTokenProvider> {
  return (async () => {
    let tokenData = await cloud.issueFusorToken(projectId, projectSecret);
    const renewal = createTokenRenewal({
      expiresInSeconds: () => tokenData.expiresIn,
      name: "fusor",
      refresh: async () => {
        tokenData = await cloud.issueFusorToken(projectId, projectSecret);
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
