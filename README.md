<div align="center">
  <h1>Photon (Spectrum)</h1>
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
     providers: [imessage.config()],
   });

   for await (const [space, message] of app.messages) {
     await space.responding(async () => {
       await message.reply("Hello from Spectrum.");
     });
   }
   ```

Spectrum also runs fully standalone — you can connect to a local iMessage database with the separate [`@spectrum-ts/imessage-local`](https://npmjs.com/package/@spectrum-ts/imessage-local) package, bring your own gRPC endpoints, or build your own platform provider. See the [docs](https://docs.photon.codes) for self-hosted setups.

## Startup cancellation

Pass an `AbortSignal` to cancel initialization. The signal applies only until `Spectrum()` returns. It does not stop a successfully initialized instance.

```typescript
const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
  signal: AbortSignal.timeout(10_000),
});
```

Project lookup and cloud iMessage, WhatsApp Business, and Slack token requests use this signal through response-body reads. Telegram webhook registration also receives it. No startup deadline applies unless the caller supplies one.

If initialization fails, Spectrum destroys providers that already returned a client and awaits their cleanup before rejecting. If a provider ignores cancellation, startup still waits for that provider to settle. Cleanup that never settles also keeps startup pending. This option does not interrupt imports, Terminal startup, local iMessage startup, or the later lazy Fusor connection.

If cleanup fails, the factory throws `SpectrumStartupCleanupError`. Its `cause` is the startup error, and its `errors` contain the cleanup failures. Do not automatically start a replacement after this error because resources can remain active.

Provider authors receive `signal` in `lifecycle.createClient`. Pass it to startup I/O, but do not keep it for later client operations. If `createClient` fails before returning, the provider must clean up its own partial resources. Cloud token renewals use a separate lifetime signal, and `await renewal.dispose()` cancels and settles an active refresh before teardown. Later calls to `forceRefresh()` or `refreshIfNeeded()` reject after disposal. Update core and provider packages together to enable startup cancellation.

Cancellation does not prove that the server rolled back a request that it already received. It does not replay messages or change delivery guarantees.

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
