import { definePlatform } from "@spectrum-ts/core";
import { createClient, destroyClient, type WeChatClient } from "./client";
import { configSchema, WECHAT_PLATFORM } from "./config";
import { messages } from "./inbound/messages";
import { send } from "./outbound/send";
import { createSpace, resolveUser } from "./space";

export type {
  QrCodeHandler,
  VerifyCodeHandler,
  WeChatConfig,
  WeChatLoginConfig,
} from "./config";
// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export {
  WeChatApiError,
  WeChatContextTokenError,
  WeChatLoginError,
  WeChatSessionPausedError,
} from "./errors";
export { type LoginOptions, loginWithQrCode } from "./login";
export type { WeChatCredentials } from "./types";

/**
 * WeChat provider for Spectrum, on Tencent's iLink bot API (the official
 * personal-WeChat bot channel).
 *
 * `createClient` resolves credentials — `botToken`, else the `stateFile`, else
 * an interactive QR login — and inbound messages arrive over iLink's
 * `getupdates` long-poll, so no public webhook is needed. v1 handles 1:1 text
 * plus typing indicators; each reply echoes the user's latest
 * `context_token`. Drop `wechat.config({...})` into
 * `Spectrum({ providers: [...] })`.
 */
export const wechat = definePlatform(WECHAT_PLATFORM, {
  config: configSchema,
  // Inline arrows (not bare references) so `_Client` is inferred from
  // `createClient` before the client-typed callbacks are checked.
  lifecycle: {
    createClient: ({ config, signal, store }): Promise<WeChatClient> =>
      createClient({ config, signal, store }),
    destroyClient: ({ client }) => destroyClient({ client }),
  },
  user: { resolve: resolveUser },
  space: { create: createSpace },
  messages: ({ client }) => messages({ client }),
  send: ({ client, content, space }) => send({ client, content, space }),
});
