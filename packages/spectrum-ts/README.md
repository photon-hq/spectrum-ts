# spectrum-ts

Bring agents to any interface — a unified messaging SDK for TypeScript.

`spectrum-ts` is the **batteries-included** package: it bundles the runtime
([`@spectrum-ts/core`](https://npmjs.com/package/@spectrum-ts/core)) plus
every official provider, so one install gets you everything.

```sh
bun add spectrum-ts
```

```ts
import { Spectrum } from "spectrum-ts";
import { telegram } from "spectrum-ts/providers/telegram";

const app = await Spectrum({ providers: [telegram.config({ botToken: "…" })] });
```

## Lean installs

If you only use a couple of platforms and want a smaller install, depend on the
runtime and just the providers you need instead of this metapackage:

```sh
bun add @spectrum-ts/core @spectrum-ts/telegram
```

```ts
import { Spectrum } from "@spectrum-ts/core";
import { telegram } from "@spectrum-ts/telegram";
```

| Platform | Package |
|----------|---------|
| iMessage | [`@spectrum-ts/imessage`](https://npmjs.com/package/@spectrum-ts/imessage) |
| Telegram | [`@spectrum-ts/telegram`](https://npmjs.com/package/@spectrum-ts/telegram) |
| Slack | [`@spectrum-ts/slack`](https://npmjs.com/package/@spectrum-ts/slack) |
| WhatsApp Business | [`@spectrum-ts/whatsapp-business`](https://npmjs.com/package/@spectrum-ts/whatsapp-business) |
| Terminal | [`@spectrum-ts/terminal`](https://npmjs.com/package/@spectrum-ts/terminal) |

See the [documentation](https://photon.codes/spectrum) for the full guide.
