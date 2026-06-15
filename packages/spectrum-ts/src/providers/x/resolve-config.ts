import type { Store } from "../../utils/store";
import type { XConfig, XEffectiveConfig } from "./config";
import { getDirectAuth } from "./direct-auth";

export const resolveEffectiveConfig = async (
  config: XConfig,
  store: Store
): Promise<XEffectiveConfig> => {
  // SDK-side refresh (BYO-app): the sidecar holds the current rotated token.
  const directAuth = getDirectAuth(store);
  const accessToken = directAuth
    ? await directAuth.getAccessToken()
    : config.accessToken;
  return {
    accessToken,
    baseUrl: config.baseUrl,
    consumerSecret: config.consumerSecret,
    xUserId: config.xUserId,
  };
};

export const resolveXUserId = (config: XConfig): string => config.xUserId;
