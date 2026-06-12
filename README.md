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
2. Install the SDK:

   ```bash
   bun add spectrum-ts @photon-ai/spectrum-provider-imessage
   ```

3. Start your app:

   ```typescript
   import { Spectrum } from "spectrum-ts";
   import { imessage } from "@photon-ai/spectrum-provider-imessage";

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

Spectrum also runs fully standalone — you can connect to a local iMessage database, bring your own gRPC endpoints, or build your own platform provider. See the [docs](https://docs.photon.codes) for self-hosted setups.

## Documentation

Visit **[docs.photon.codes](https://docs.photon.codes)** to view the full documentation.

## Platforms

| Platform | Package |
|----------|---------|
| iMessage | [`@photon-ai/spectrum-provider-imessage`](https://npmjs.com/package/@photon-ai/spectrum-provider-imessage) |
| WhatsApp Business | [`@photon-ai/spectrum-provider-whatsapp-business`](https://npmjs.com/package/@photon-ai/spectrum-provider-whatsapp-business) |
| Telegram | [`@photon-ai/spectrum-provider-telegram`](https://npmjs.com/package/@photon-ai/spectrum-provider-telegram) |
| Slack | [`@photon-ai/spectrum-provider-slack`](https://npmjs.com/package/@photon-ai/spectrum-provider-slack) |
| Terminal | [`@photon-ai/spectrum-provider-terminal`](https://npmjs.com/package/@photon-ai/spectrum-provider-terminal) |
| Custom   | `definePlatform` from `spectrum-ts` |

Each provider lives in its own package, so you only install the platform SDKs you actually use. The v4 import paths (`spectrum-ts/providers/<platform>`) still work once the matching provider package is installed — if it isn't, the import fails at build/startup naming the exact package to add.

## Issues

Found a bug or have a feature request? Please [open an issue](https://github.com/photon-hq/spectrum-ts/issues) on GitHub. Before filing, search existing issues to avoid duplicates.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

[MIT](./LICENSE) © [Photon](https://photon.codes)
