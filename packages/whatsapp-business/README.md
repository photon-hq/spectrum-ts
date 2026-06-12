# @photon-ai/spectrum-provider-whatsapp-business

WhatsApp Business provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Install

```sh
bun add spectrum-ts @photon-ai/spectrum-provider-whatsapp-business
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { whatsappBusiness } from "@photon-ai/spectrum-provider-whatsapp-business";

const spectrum = Spectrum({
  providers: [whatsappBusiness.config({ /* ... */ })],
});
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
