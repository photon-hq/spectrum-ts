# @spectrum-ts/telegram

Telegram provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts). Inbound is delivered through Fusor webhooks; outbound goes through the Telegram Bot API.

## Install

```sh
bun add spectrum-ts @spectrum-ts/telegram
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { telegram } from "@spectrum-ts/telegram";

const spectrum = Spectrum({
  providers: [telegram.config({ botToken: "..." })],
});
```

See the [telegram guide](https://github.com/photon-hq/spectrum-ts/blob/main/docs/telegram.md) for the full setup.
