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
attachment lookup through the local Messages database. Message and attachment
results are cached per client. Because `@photon-ai/imessage-kit` does not
currently expose direct message- or attachment-GUID filters, uncached lookups
use bounded pagination (up to 10,000 rows) and may return `undefined` for older
records.

## Inbound events

The message stream surfaces local Tapback additions and removals as universal
`reaction` content. Membership and group-name changes use Spectrum's universal
`addMember`, `removeMember`, and `rename` content shapes. Poll votes contain
only the target message id exposed by the local database, so they surface as
`custom` content with `raw.imessage_type === "poll-vote"`.
