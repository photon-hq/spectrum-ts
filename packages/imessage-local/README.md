# `@spectrum-ts/imessage-local`

Local macOS iMessage provider for spectrum-ts, powered by `@photon-ai/imessage-kit`.

```sh
bun add spectrum-ts @spectrum-ts/imessage-local
```

```ts
import { imessage } from "@spectrum-ts/imessage-local";
import { Spectrum } from "spectrum-ts";

const spectrum = Spectrum({
  platforms: [imessage.config()],
});
```

This package is intentionally not included in the batteries-included
`spectrum-ts` package. Install it only on the macOS host that will access the
local Messages database.
