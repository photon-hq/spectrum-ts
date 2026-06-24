# @spectrum-ts/hono

[Hono](https://hono.dev) webhook adapter for [spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Install

```sh
bun add spectrum-ts @spectrum-ts/hono hono
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/hono";
import { Hono } from "hono";

const app = await Spectrum({
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET,
});

const server = new Hono().route(
  "/",
  spectrum({
    app,
    onMessage: async (space, message) => {
      if (message.content.type === "text") {
        await space.send(`echo: ${message.content.text}`);
      }
    },
  })
);
```

> Using the batteries-included `spectrum-ts` metapackage? Import from
> `spectrum-ts/hono` instead — it re-exports this package.

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
