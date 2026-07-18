# `@spectrum-ts/imessage-local`

Local macOS iMessage provider for spectrum-ts, powered by `@photon-ai/imessage-kit`.

Registers as `"iMessage (local mode)"` (not cloud `"iMessage"`), so platform
identity stays unambiguous when both packages are installed.

```sh
bun add spectrum-ts @spectrum-ts/imessage-local
```

```ts
import { imessage } from "@spectrum-ts/imessage-local";
import { Spectrum } from "spectrum-ts";

const spectrum = await Spectrum({
  platforms: [imessage.config()],
});
```

This package is intentionally not included in the batteries-included
`spectrum-ts` package. Install it only on the macOS host that will access the
local Messages database.
