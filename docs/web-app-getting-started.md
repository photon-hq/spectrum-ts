# Web App Getting Started

Use Spectrum from a web chat built with Vercel AI SDK UI.

`webChat` is the Spectrum provider for browser chat. `SpectrumChatTransport` is
the AI SDK transport that lets a web UI talk to that provider. You do not need
to add a Next.js `/api/chat` route just to use Spectrum.

## Installation

```bash
bun add spectrum-ts ai @ai-sdk/react
```

Use the package manager for your app if you are not using Bun.

## Core concepts

Spectrum web apps have two pieces:

| Piece | What it does |
| --- | --- |
| Web UI | Renders chat and calls `useChat` with `SpectrumChatTransport`. |
| Spectrum runtime | Runs `Spectrum({ providers: [...] })` with `webChat` and any other providers. |

The web UI and the Spectrum runtime are separate because browser code cannot
hold long-running provider connections. The runtime is the same kind of
Spectrum app you already use for iMessage, terminal, or WhatsApp. `webChat` just
adds a web entrypoint to it.

```txt
web UI
-> useChat + SpectrumChatTransport
-> Spectrum runtime /ai-sdk/chat
-> webChat provider
-> app.messages
-> space.send(...)
```

## Quickstart

### 1. Add `webChat` to your Spectrum runtime

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { webChat } from "spectrum-ts/providers/web-chat";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [
    webChat.config({
      server: {
        cors: {
          origins: ["http://127.0.0.1:5173"],
        },
        port: 8787,
      },
    }),
    imessage.config(),
    terminal.config(),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  await space.send("Hello from Spectrum.");
}
```

For a web-only local test, you can start with only `webChat.config()`:

```ts
const app = await Spectrum({
  providers: [webChat.config()],
});
```

Project-backed providers such as iMessage still use your Photon project
credentials. Projectless providers such as terminal can run without them.

### 2. Point your web chat at the Spectrum runtime

```tsx
import { useChat } from "@ai-sdk/react";
import { SpectrumChatTransport } from "spectrum-ts/adapters/ai-sdk";

const { messages, sendMessage, status } = useChat({
  transport: new SpectrumChatTransport({
    endpoint: "http://127.0.0.1:8787/ai-sdk/chat",
  }),
});
```

The `endpoint` is the `webChat` URL exposed by the Spectrum runtime. In local
development the default is:

```txt
http://127.0.0.1:8787/ai-sdk/chat
```

In production, use the HTTPS URL where your Spectrum runtime is deployed. If
Photon hosts the runtime for you, this is the URL your Photon project provides.

### 3. Send a message

```tsx
sendMessage({ text: "hello from the browser" });
```

The message enters the same `app.messages` loop as iMessage and terminal. Your
agent code does not need a separate web-only path.

## Multi-platform web chat

Add providers to the runtime, not to the web app:

```ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [
    webChat.config(),
    imessage.config(),
    terminal.config(),
  ],
});

for await (const [space, message] of app.messages) {
  await space.send("One agent loop, many surfaces.");
}
```

The web UI still only needs `SpectrumChatTransport`. The extra providers live in
the Spectrum runtime.

## Do I need an API route?

No. The simplest path is:

```txt
useChat
-> SpectrumChatTransport
-> Spectrum runtime webChat endpoint
```

A web framework route is optional. You might add one if you want a same-origin
proxy, custom authentication, or to hide the runtime URL from browser code. That
route should stay thin and forward to the Spectrum runtime; it should not own
the Spectrum provider loop.

## Current MVP limits

This web app path is text-first:

- text input
- text output
- request-scoped AI SDK UI response
- one `app.messages` loop shared with other Spectrum providers

Not yet included:

- AI SDK Core model adapter
- tool-call UI rendering
- files and attachments
- resumable streams
- rich generative UI parts
