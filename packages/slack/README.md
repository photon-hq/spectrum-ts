# @spectrum-ts/slack

Slack provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Install

```sh
bun add spectrum-ts @spectrum-ts/slack
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { slack } from "@spectrum-ts/slack";

const spectrum = Spectrum({
  providers: [slack.config({ tokens: { T012ABCDE: "xoxb-..." } })],
});
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.
