# iMessage cloud example

A minimal Spectrum app on the cloud iMessage provider: it echoes every inbound
text back, reacts with a tapback, and shows a typing indicator while it "thinks".

It demonstrates the core loop and the three most common message/space APIs:

- `for await (const [space, message] of app.messages)` — the inbound stream
- `message.react(emoji)` — a tapback on the incoming message
- `space.responding(fn)` — a typing indicator around async work
- `message.reply(content)` — a threaded reply

## Run

Create a project and an iMessage line at [photon.codes](https://photon.codes),
then pass the credentials via the environment:

```sh
SPECTRUM_PROJECT_ID=... SPECTRUM_PROJECT_SECRET=... bun run index.ts
```

Text the bot's line and it replies `echo: <your message>`.

You can also pass credentials explicitly instead of via env:

```ts
await Spectrum({
  projectId: "...",
  projectSecret: "...",
  providers: [imessage.config()],
});
```

## Local mode

To run against the Messages app and `chat.db` on your own Mac instead of the
cloud (no project needed), see the sibling [`imessage-local`](../imessage-local)
example, which uses `@spectrum-ts/imessage-local`.

## Production use

This example deliberately handles one message at a time so the provider APIs
stay easy to see. It catches failures per message to keep the listener alive,
but a production agent should move work into per-space queues and add
debouncing, cancellation, idempotency, and durable recovery. See Photon's
[architecture](https://photon.codes/docs/best-practices/architecture),
[inbound pipeline](https://photon.codes/docs/best-practices/inbound-pipeline),
and [recovery and state](https://photon.codes/docs/best-practices/recovery-and-state)
guides.
