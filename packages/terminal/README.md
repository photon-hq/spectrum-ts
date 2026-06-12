# @photon-ai/spectrum-provider-terminal

Terminal provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts) — chat with your agent from the command line via the standalone [tuichat](https://github.com/photon-hq/tuichat) binary (auto-downloaded on first use).

## Install

```sh
bun add spectrum-ts @photon-ai/spectrum-provider-terminal
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { terminal } from "@photon-ai/spectrum-provider-terminal";

const spectrum = Spectrum({ providers: [terminal] });
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
