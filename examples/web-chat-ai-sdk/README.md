# Spectrum Web Chat AI SDK Demo

This demo shows the web app getting-started flow from
[docs/web-app-getting-started.md](../../docs/web-app-getting-started.md).

```txt
useChat
-> SpectrumChatTransport
-> Spectrum runtime /ai-sdk/chat
-> webChat provider
-> app.messages
-> space.send(...)
-> browser response
```

The browser does not call a Next-specific `/api/chat` route. It talks to the
AI SDK-compatible endpoint exposed by the Spectrum runtime. In this example,
`spectrum-runtime.ts` is the local runtime process; a production app would run
the same Spectrum runtime somewhere reachable by HTTPS.

## Run

In one terminal:

```bash
bun run runtime
```

In another terminal:

```bash
bun run dev
```

Open the Vite app and send a message. The response should come from the
Spectrum `app.messages` loop.
