<div align="center">
  <h1>Spectrum</h1>
  <p><strong>Bring agents to any interface.</strong></p>
  
  Photon (photon.codes) builds Spectrum, a multi-channel agent framework that makes AI agents reachable over real conversation surfaces like iMessage, SMS, and email instead of trapping them in web chat.
  
  <p>
    <a href="https://www.npmjs.com/package/spectrum-ts"><img src="https://img.shields.io/npm/v/spectrum-ts.svg?style=flat&colorA=1a1a1a&colorB=3178c6" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/spectrum-ts"><img src="https://img.shields.io/npm/dm/spectrum-ts.svg?style=flat&colorA=1a1a1a&colorB=3178c6" alt="npm downloads" /></a>
    <a href="https://github.com/photon-hq/spectrum-ts/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/spectrum-ts.svg?style=flat&colorA=1a1a1a&colorB=3178c6" alt="license" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5+-3178c6?style=flat&colorA=1a1a1a&colorB=3178c6" alt="TypeScript" /></a>
    <a href="https://github.com/photon-hq/spectrum-ts/stargazers"><img src="https://img.shields.io/github/stars/photon-hq/spectrum-ts.svg?style=flat&colorA=1a1a1a&colorB=3178c6" alt="github stars" /></a>
  </p>
</div>

## About Photon

**[Photon](https://photon.codes)** builds infrastructure for AI agents that operate over real communication channels.

Spectrum is Photon’s open-source multi-channel agent framework, enabling AI agents to communicate through interfaces people already use—such as iMessage, SMS, email, Slack, Discord, and voice—instead of being confined to web chat.

Learn more at **https://photon.codes**.

## Getting Started

The fastest way to ship is with **Spectrum Cloud** — hosted infrastructure for platforms like iMessage, with credentials ready in minutes.

1. Sign up at **[app.photon.codes](https://app.photon.codes)** to get your project ID and secret.
2. Install the SDK (`spectrum-ts` is batteries-included — the runtime plus
   the standard provider set):

   ```bash
   bun add spectrum-ts
   ```

3. Start your app:

   ```typescript
   import { Spectrum } from "spectrum-ts";
   import { imessage } from "spectrum-ts/providers/imessage";

   const app = await Spectrum({
     projectId: process.env.PROJECT_ID,
     projectSecret: process.env.PROJECT_SECRET,
     platforms: [imessage.config()],
   });

   for await (const [space, message] of app.messages) {
     await space.responding(async () => {
       await message.reply("Hello from Spectrum.");
     });
   }
   ```

Spectrum also runs fully standalone — you can connect to a local iMessage database with the separate [`@spectrum-ts/imessage-local`](https://npmjs.com/package/@spectrum-ts/imessage-local) package, bring your own gRPC endpoints, or build your own platform provider. See the [docs](https://docs.photon.codes) for self-hosted setups.

### Production Fusor stream resume

When `app.messages` consumes a Fusor-backed provider (for example Telegram),
inbound events arrive over a long-lived WebSocket. This path requires a runtime
with a global standards-compatible `WebSocket`: use Bun or Node 22 or newer.
On an older Node release, install a compatible implementation and assign it to
`globalThis.WebSocket` before initializing Spectrum. Spectrum keeps a
process-local cursor by default, which survives reconnects but not a process
restart. Production services can supply a durable cursor store:

```typescript
import { Spectrum, type FusorCursorStore } from "spectrum-ts";
import { telegram } from "spectrum-ts/providers/telegram";

const fusorCursorStore: FusorCursorStore = {
  async load(projectId) {
    return database.cursors.get(projectId);
  },
  async save(projectId, seq) {
    // Commit durably and monotonically before this promise resolves.
    await database.cursors.advance(projectId, seq);
  },
};

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  platforms: [telegram.config({ botToken: process.env.TELEGRAM_BOT_TOKEN! })],
  options: { fusorCursorStore },
});
```

Namespace stored cursors by Fusor deployment or stream identity in addition to
project ID; never reuse a production cursor in staging. Spectrum checkpoints
only after the provider pipeline has accepted the event and any synchronous
reply has been queued. Delivery remains at-least-once, so application side
effects should still be idempotent.

Spectrum also bounds the WebSocket event backlog to 64 admitted events and
8 MiB of UTF-8 event-frame data by default (the currently executing handler is
included). If either limit is exceeded, Spectrum closes the session, discards
unstarted queued work, and reconnects from the last durable cursor; the
overflowing event is never checkpointed. Tune the bounds with
`options.fusorMaxPendingEvents` and `options.fusorMaxPendingBytes` when provider
latency and payload sizes justify it.

Shutdown aborts the `signal` passed to each Fusor provider's `messages`
context. Providers should pass that signal to cancellable I/O. Spectrum waits
at most `options.fusorShutdownTimeoutMs` (2 seconds by default) for a handler
that ignores cancellation, then lets shutdown finish without replying to or
checkpointing that event.

Initial token issuance and connection failures use the same referenced retry
loop, so a stream-only Node worker remains alive during reconnect backoff until
`app.stop()` cancels it.

## Documentation

Visit **[docs.photon.codes](https://docs.photon.codes)** to view the full documentation.

## Platforms

| Platform | Package |
|----------|---------|
| iMessage | [`@spectrum-ts/imessage`](https://npmjs.com/package/@spectrum-ts/imessage) |
| Local iMessage | [`@spectrum-ts/imessage-local`](https://npmjs.com/package/@spectrum-ts/imessage-local) (explicit install only) |
| WhatsApp Business | [`@spectrum-ts/whatsapp-business`](https://npmjs.com/package/@spectrum-ts/whatsapp-business) |
| Telegram | [`@spectrum-ts/telegram`](https://npmjs.com/package/@spectrum-ts/telegram) |
| Slack | [`@spectrum-ts/slack`](https://npmjs.com/package/@spectrum-ts/slack) |
| Terminal | [`@spectrum-ts/terminal`](https://npmjs.com/package/@spectrum-ts/terminal) |
| Custom   | `definePlatform` from `spectrum-ts` |

`bun add spectrum-ts` is batteries-included (the standard provider set; local iMessage is an explicit install). For a smaller install, depend on the runtime plus only the providers you use — `bun add @spectrum-ts/core @spectrum-ts/telegram` — and import from the scoped packages directly. Either way the `spectrum-ts/providers/<platform>` import paths work as long as the matching provider package is installed; if it isn't, the import fails at build/startup naming the exact package to add.

## Issues

Found a bug or have a feature request? Please [open an issue](https://github.com/photon-hq/spectrum-ts/issues) on GitHub. Before filing, search existing issues to avoid duplicates.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

[MIT](./LICENSE) © [Photon](https://photon.codes)
