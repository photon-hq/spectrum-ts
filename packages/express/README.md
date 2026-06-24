# @spectrum-ts/express

[Express](https://expressjs.com) webhook adapter for [spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Install

```sh
bun add spectrum-ts @spectrum-ts/express express
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/express";
import express from "express";

const app = await Spectrum({
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET,
});

const server = express();
// Mount before any global express.json() — the plugin needs the raw body.
server.use(
  spectrum({
    app,
    onMessage: async (space, message) => {
      if (message.content.type === "text") {
        await space.send(`echo: ${message.content.text}`);
      }
    },
  })
);
server.listen(3000);
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
