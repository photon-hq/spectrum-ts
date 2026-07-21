# iMessage local example

A minimal Spectrum app on the **local** iMessage provider
(`@spectrum-ts/imessage-local`). It reads the Messages app + `chat.db` on your
own Mac — no cloud project or credentials needed — and echoes every inbound
text back with a fresh send.

Local mode is a strict subset of cloud: plain sends work, but tapbacks
(`message.react`) and threaded replies (`message.reply`) require cloud iMessage.
Spectrum warns and resolves those calls with `undefined` in local mode instead
of throwing to the caller. There is no typing indicator, so `space.responding`
just runs the callback. The app-level API is otherwise the same as the
[`imessage-cloud`](../imessage-cloud) example, which keeps handlers portable
across transports.

## Run

Sign into the Messages app on the Mac, then grant your terminal **Full Disk
Access** (System Settings → Privacy & Security → Full Disk Access) so it can
read `~/Library/Messages/chat.db`. Then run:

```sh
bun run index.ts
```

Text the Mac's line and it replies `echo: <your message>`.

## Production use

This example deliberately handles one message at a time so the provider APIs
stay easy to see. It catches failures per message to keep the listener alive,
but a production agent should move work into per-space queues and add
debouncing, cancellation, idempotency, and durable recovery. See Photon's
[architecture](https://photon.codes/docs/best-practices/architecture),
[inbound pipeline](https://photon.codes/docs/best-practices/inbound-pipeline),
and [recovery and state](https://photon.codes/docs/best-practices/recovery-and-state)
guides.
