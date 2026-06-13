# @spectrum-ts/imessage

iMessage provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts), supporting local (imessage-kit) and remote (advanced-imessage) modes — including tapbacks, special effects, polls, and mini-apps.

## Install

```sh
bun add spectrum-ts @spectrum-ts/imessage
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

const spectrum = Spectrum({
  providers: [imessage.config({ /* ... */ })],
});
```

This package also exports the iMessage-specific content helpers `effect`, `read`, `background`, and `customizedMiniApp`.

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
