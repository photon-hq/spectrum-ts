# Next Vercel AI SDK Chat Demo

This example shows the customer-facing Phase 2B path:

```txt
Browser useChat
  -> Next.js /api/chat
  -> createSpectrumWorkerBridge(...)
  -> long-running Spectrum worker webBridge
  -> app.messages
  -> space.send(...)
  -> browser renders assistant response
```

## Run

Start a Spectrum worker first. You can use `examples/web-bridge-worker` for a
terminal-backed worker or the iMessage + webBridge worker used in manual
testing.

Then start this Next app:

```bash
SPECTRUM_WORKER_URL="http://127.0.0.1:8787/spectrum/web/messages" \
SPECTRUM_WORKER_API_KEY="dev" \
bun run dev
```

Open:

```txt
http://localhost:3007
```

Send a message. The response should come from the Spectrum worker.
