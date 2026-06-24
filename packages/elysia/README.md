# @spectrum-ts/elysia

[ElysiaJS](https://elysiajs.com) webhook adapter for [spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Install

```sh
bun add spectrum-ts @spectrum-ts/elysia elysia
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/elysia";
import { Elysia } from "elysia";

const app = await Spectrum({
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET,
});

new Elysia()
  .use(
    spectrum({
      app,
      onMessage: async (space, message) => {
        if (message.content.type === "text") {
          await space.send(`echo: ${message.content.text}`);
        }
      },
    })
  )
  .listen(3000);
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
