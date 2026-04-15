// biome-ignore lint/performance/noBarrelFile: library entry point
export { definePlatform } from "./platform/define";
export type {
  AnyPlatformDef,
  EventProducer,
  Platform,
  PlatformDef,
  PlatformInstance,
  PlatformMessage,
  PlatformProviderConfig,
  PlatformSpace,
  PlatformUser,
  SchemaMessage,
} from "./platform/types";
export { Spectrum, type SpectrumInstance } from "./spectrum";
export {
  attachment,
  type Content,
  type ContentBuilder,
  custom,
  text,
} from "./types/content";
export type { Message } from "./types/message";
export type { Space } from "./types/space";
export type { User } from "./types/user";
export type {
  CloudPlatform,
  DedicatedTokenData,
  ImessageInfoData,
  PlatformStatus,
  PlatformsData,
  SharedTokenData,
  SubscriptionData,
  SubscriptionStatus,
  TokenData,
} from "./utils/cloud";
export { cloud, SpectrumCloudError } from "./utils/cloud";
export { type ManagedStream, mergeStreams, stream } from "./utils/stream";
