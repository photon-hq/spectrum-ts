# `@spectrum-ts/imessage-local`

Local macOS iMessage provider for spectrum-ts, powered by `@photon-ai/imessage-kit`.

```sh
bun add spectrum-ts @spectrum-ts/imessage-local
```

```ts
import { localIMessage } from "@spectrum-ts/imessage-local";
import { Spectrum } from "spectrum-ts";

const spectrum = Spectrum({
  providers: [localIMessage.config()],
});
```

This package is intentionally not included in the batteries-included
`spectrum-ts` package. Install it only on the macOS host that will access the
local Messages database.

## Local lookups

The provider supports `space.getMessage(id)`, chat display-name lookup, and
attachment lookup through the local Messages database. Results are cached per
client. Because `@photon-ai/imessage-kit` does not currently expose direct
message- or attachment-GUID filters, uncached lookups use bounded pagination
(up to 10,000 rows) and may return `undefined` for older records.
