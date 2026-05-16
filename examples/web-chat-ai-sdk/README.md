# Spectrum Web Chat AI SDK Demo

This demo shows the target developer story:

```txt
useChat
-> SpectrumChatTransport
-> webChat provider
-> app.messages
-> space.send(...)
-> browser response
```

The browser does not call a Next-specific `/api/chat` route. It talks to the
AI SDK-compatible endpoint exposed by the local Spectrum runtime.

## Run

In one terminal:

```bash
bun run agent
```

In another terminal:

```bash
bun run dev
```

Open the Vite app and send a message. The response should come from the
Spectrum `app.messages` loop.
