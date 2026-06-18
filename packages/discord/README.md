# @spectrum-ts/discord

Discord provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts). Inbound is delivered through Fusor webhooks; outbound goes through the Discord REST API.

## Install

```sh
bun add spectrum-ts @spectrum-ts/discord
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { discord } from "@spectrum-ts/discord";

const spectrum = Spectrum({
  providers: [discord.config({ botToken: "..." })],
});
```

See [the Discord provider docs](https://github.com/photon-hq/spectrum-ts/blob/main/docs/discord.md) for the full configuration and feature reference.
