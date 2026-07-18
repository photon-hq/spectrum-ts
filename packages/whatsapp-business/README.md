# @spectrum-ts/whatsapp-business

WhatsApp Business provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Install

```sh
bun add spectrum-ts @spectrum-ts/whatsapp-business
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { whatsappBusiness } from "@spectrum-ts/whatsapp-business";

const spectrum = Spectrum({
  providers: [whatsappBusiness.config({ /* ... */ })],
});
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
