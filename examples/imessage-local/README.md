# iMessage local example

A minimal Spectrum app on the **local** iMessage provider
(`@spectrum-ts/imessage-local`). It reads the Messages app + `chat.db` on your
own Mac — no cloud project or credentials needed — and echoes every inbound
text back with a fresh send.

Local mode is a strict subset of cloud: plain sends work, but tapbacks
(`message.react`) and threaded replies (`message.reply`) require cloud iMessage
and throw `UnsupportedError` here, and there is no typing indicator (so
`space.responding` just runs the callback). The app-level API is otherwise the
same as the [`imessage-cloud`](../imessage-cloud) example, which keeps handlers
portable across transports.

## Run

Grant your terminal **Full Disk Access** (System Settings → Privacy & Security
→ Full Disk Access) so it can read `~/Library/Messages/chat.db`, then:

```sh
bun run index.ts
```

Text the Mac's line and it replies `echo: <your message>`.
