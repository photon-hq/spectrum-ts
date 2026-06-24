# @spectrum-ts/fastify

[Fastify](https://fastify.dev) webhook adapter for [spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Install

```sh
bun add spectrum-ts @spectrum-ts/fastify fastify
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/fastify";
import Fastify from "fastify";

const app = await Spectrum({
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET,
});

const server = Fastify();
// The plugin owns its own raw-body parser in an encapsulated scope.
server.register(spectrum, {
  app,
  onMessage: async (space, message) => {
    if (message.content.type === "text") {
      await space.send(`echo: ${message.content.text}`);
    }
  },
});
// Await listen so a startup failure surfaces instead of going unhandled.
await server.listen({ port: 3000 });
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
