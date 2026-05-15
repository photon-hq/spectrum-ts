# Progressive Provider Worker

This example shows the customer upgrade path without changing the app logic:

```txt
webBridge only
-> add iMessage
-> add terminal
```

The important point is that `agent.ts` owns the remembered-facts app loop. The
entry files only change the provider list:

```txt
web-only.ts
web-imessage.ts
web-imessage-terminal.ts
```

## Web only

```bash
SPECTRUM_WORKER_API_KEY="dev" \
SPECTRUM_WORKER_PORT=8791 \
bun run start:web-only
```

## Web + iMessage

```bash
SPECTRUM_PROJECT_ID="..." \
SPECTRUM_PROJECT_SECRET="..." \
SPECTRUM_WORKER_API_KEY="dev" \
SPECTRUM_WORKER_PORT=8791 \
bun run start:web-imessage
```

## Web + iMessage + terminal

```bash
SPECTRUM_PROJECT_ID="..." \
SPECTRUM_PROJECT_SECRET="..." \
SPECTRUM_WORKER_API_KEY="dev" \
SPECTRUM_WORKER_PORT=8791 \
bun run start:web-imessage-terminal
```

Point the Next.js `useChat` demo at:

```txt
http://127.0.0.1:8791/spectrum/web/messages
```

Then test facts with:

```txt
remember my favorite color is green
what is my favorite color?
```

## Identity model

The browser still talks to the Next.js `/api/chat` route, not directly to this
worker. The route authenticates the request, keeps `SPECTRUM_WORKER_API_KEY`
server-side, and sends the worker:

```txt
useChat id = browser conversation id
getUser(request).id = authenticated app user id
spaceId = web:<userId>:<conversationId>
responseSessionId = one active browser request
```

This demo maps all enabled transports to `SPECTRUM_DEMO_USER_ID` so you can
teach a fact in iMessage and read it from the browser. Production apps should
replace that with an app-owned identity/memory layer such as Postgres, Redis, a
vector store, CRM data, or an account-linking table.
