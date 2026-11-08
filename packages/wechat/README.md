# @spectrum-ts/wechat

WeChat provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts), built on **iLink**, Tencent's official bot channel for personal WeChat accounts (the "ClawBot" channel, launched in March 2026). Inbound messages arrive over iLink's long-poll API, so you don't need a public webhook. You connect by scanning a QR code with WeChat.

v1 covers 1:1 text messages and typing indicators. Media and group chats are not supported yet.

## Install

```sh
bun add spectrum-ts @spectrum-ts/wechat
```

## Use

```ts
import { Spectrum, text } from "spectrum-ts";
import { wechat } from "@spectrum-ts/wechat";

const app = await Spectrum({
  providers: [
    wechat.config({
      // Keeps the login, inbound cursor and context tokens across restarts.
      stateFile: ".wechat-state.json",
      login: {
        onQrCode: (url) => console.log(`Scan with WeChat: ${url}`),
      },
    }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(text(`echo: ${message.content.text}`));
  }
}
```

On the first start, `Spectrum()` waits until you scan the QR code and confirm in WeChat (8 minutes by default). Later starts reuse the credentials saved in `stateFile`. [`examples/wechat-echo`](../../examples/wechat-echo) renders the QR code in the terminal.

### Config

| Field | Env fallback | Description |
|---|---|---|
| `botToken` | `SPECTRUM_WECHAT_BOT_TOKEN` | Token from an earlier login. Without one (and without saved credentials), `createClient` runs the QR login. |
| `baseUrl` | `SPECTRUM_WECHAT_BASE_URL` | API origin that goes with `botToken` (the login may assign a regional host). Default `https://ilinkai.weixin.qq.com`. |
| `stateFile` | `SPECTRUM_WECHAT_STATE_FILE` | JSON file for credentials, cursor and context tokens, written with mode `0600`. Without it, this state lives in memory only. |
| `login.onQrCode` | – | `(url) => void`: show the QR code. By default the URL is logged. |
| `login.onVerifyCode` | – | `() => string`: return the number WeChat shows on the phone when it asks for extra verification. |
| `login.timeoutMs` | – | How long to wait for the scan. Default 480000. |

If you'd rather log in ahead of time (for example in a setup script), call `loginWithQrCode()` and keep the `botToken` and `baseUrl` it returns.

```ts
import { loginWithQrCode } from "@spectrum-ts/wechat";

const { botToken, baseUrl } = await loginWithQrCode({ onQrCode: console.log });
```

## How it behaves

- **Spaces.** A space is a 1:1 chat, and its id is the other user's iLink id (`…@im.wechat`, the same value as `message.sender.id`). `space.create` accepts exactly one user.
- **Context tokens.** Every inbound message carries a `context_token`, and iLink expects replies to echo the latest one. The provider caches a token per user and attaches it to sends. A user who hasn't messaged the bot has no cached token. In that case the send is still attempted, and if iLink rejects it you get a `WeChatContextTokenError`. Tencent hasn't documented how long a token stays valid.
- **Content.** Only `text` and `typing` are sent natively. Core turns `markdown` and streamed text into plain text. Other content types log a warning and are skipped.
- **Errors.** A failed API call throws `WeChatApiError`, which carries `ret`, `errcode`, `errmsg` or the HTTP `status`. Error messages never include tokens. iLink code `-14` means the session expired. When that happens, the provider pauses for an hour (as Tencent's client does), and sends during the pause throw `WeChatSessionPausedError`. To reconnect, scan a new QR code: delete the state file, or unset `botToken`.
- **Delivery.** Each inbound batch is emitted before its cursor is saved, so a crash may replay messages but won't drop them. `app.stop()` aborts the in-flight long-poll right away.

## Acknowledgements

The protocol handling follows Tencent's MIT-licensed [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) plugin, particularly its [protocol reference](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md). That covers the request headers, QR login states, `getupdates` back-off, uint64-safe id parsing and the typing-ticket flow. This package was written independently and does not depend on OpenClaw.
