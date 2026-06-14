import type { Store } from "../../utils/store";
import { getCloudAuth } from "./auth";
import {
  DEFAULT_BASE_URL,
  isCloudConfig,
  type XConfig,
  type XDirectConfig,
  type XEffectiveConfig,
} from "./config";

export const resolveEffectiveConfig = async (
  config: XConfig,
  store: Store
): Promise<XEffectiveConfig> => {
  if (!isCloudConfig(config)) {
    const direct = config as XDirectConfig;
    return {
      accessToken: direct.accessToken,
      baseUrl: direct.baseUrl,
      consumerSecret: direct.consumerSecret,
      xUserId: direct.xUserId,
    };
  }

  const auth = getCloudAuth(store);
  if (!auth) {
    throw new Error(
      "X cloud mode requires credentials from createCloudAuth on the platform store."
    );
  }

  const cloud = config;
  const xUserId = auth.getXUserId();
  const [accessToken, cloudConsumerSecret] = await Promise.all([
    auth.getAccessToken(xUserId),
    auth.getConsumerSecret(),
  ]);

  return {
    accessToken,
    baseUrl: DEFAULT_BASE_URL,
    consumerSecret: cloud.consumerSecret ?? cloudConsumerSecret,
    xUserId,
  };
};

export const resolveXUserId = async (
  config: XConfig,
  store: Store
): Promise<string> => {
  if (!isCloudConfig(config)) {
    return (config as XDirectConfig).xUserId;
  }
  const auth = getCloudAuth(store);
  if (!auth) {
    throw new Error(
      "X cloud mode requires credentials from createCloudAuth on the platform store."
    );
  }
  return auth.getXUserId();
};
