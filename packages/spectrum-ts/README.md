# spectrum-ts

Bring agents to any interface — a unified messaging SDK for TypeScript.

`spectrum-ts` is the **batteries-included** package: it bundles the runtime
([`@spectrum-ts/core`](https://npmjs.com/package/@spectrum-ts/core)) plus the
standard provider set.

```sh
bun add spectrum-ts
```

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  platforms: [imessage.config()],
});
```

## Lean installs

If you only use a couple of platforms and want a smaller install, depend on the
runtime and just the providers you need instead of this metapackage:

```sh
bun add @spectrum-ts/core @spectrum-ts/imessage
```

```ts
import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
```

| Platform | Package |
|----------|---------|
| iMessage | [`@spectrum-ts/imessage`](https://npmjs.com/package/@spectrum-ts/imessage) |
| Local iMessage | [`@spectrum-ts/imessage-local`](https://npmjs.com/package/@spectrum-ts/imessage-local) (explicit install only) |
| Telegram | [`@spectrum-ts/telegram`](https://npmjs.com/package/@spectrum-ts/telegram) |
| Slack | [`@spectrum-ts/slack`](https://npmjs.com/package/@spectrum-ts/slack) |
| WhatsApp Business | [`@spectrum-ts/whatsapp-business`](https://npmjs.com/package/@spectrum-ts/whatsapp-business) |
| Terminal | [`@spectrum-ts/terminal`](https://npmjs.com/package/@spectrum-ts/terminal) |

See the [documentation](https://photon.codes/spectrum) for the full guide.
