# @photon-ai/linq

[LinQ](https://docs.linqapp.com) adapter for [Spectrum](https://photon.codes/spectrum).

- **Inbound** is delivered through **Fusor** (Spectrum's built-in inbound
  pipeline). Fusor verifies the platform signature and hands the adapter the
  raw request; the adapter verifies LinQ's webhook HMAC, parses the event, and
  produces Spectrum messages.
- **Outbound** uses LinQ's HTTP API via the official
  [`@linqapp/sdk`](https://github.com/linq-team/linq-node).

LinQ is iMessage-native, so most of Spectrum's content model maps directly:
text, attachments, voice memos, reactions (tapbacks), replies, rich links,
message effects, typing indicators, group rename / icon, and contact cards.

## Install

```sh
bun add @photon-ai/linq spectrum-ts
```

## Configure

Provision a bearer token and a webhook signing secret from your LinQ
representative, then drop the provider into `Spectrum({ providers: [...] })`:

```typescript
import { Spectrum, text } from "spectrum-ts";
import { linq } from "@photon-ai/linq";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [
    linq.config({
      apiKey: process.env.LINQ_API_KEY,
      webhookSigningSecret: process.env.LINQ_WEBHOOK_SECRET,
      defaultFrom: "+12025550123", // optional: number for proactively-created chats
    }),
  ],
});

// Streaming
for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(text(`echo: ${message.content.text}`));
  }
}
```

### Webhook mode

```typescript
// Hono / Bun.serve / Next.js / Workers — pass the raw Request.
server.post("/webhooks/fusor", (c) =>
  app.webhook(c.req.raw, async (space, message) => {
    await space.send("got it");
  })
);
```

## Config

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | yes | — | LinQ bearer token (outbound + media downloads). |
| `webhookSigningSecret` | recommended | — | Per-subscription HMAC secret. When set, inbound webhooks are verified (HMAC-SHA256 over `{timestamp}.{body}`) and replay-guarded. When omitted, verification is skipped. |
| `defaultFrom` | no | — | Provisioned phone number used when creating a new chat for a proactive send. |
| `baseUrl` | no | SDK default | Override the LinQ API base URL. |
| `replayToleranceSec` | no | `300` | Reject webhooks whose timestamp is older than this. |

## Content support

| Spectrum content | LinQ |
| --- | --- |
| `text` | text part |
| `attachment` | upload → media part (`attachment_id`) |
| `voice` | voice-memo bubble |
| `richlink` | link part (sole part) |
| `reply` | threaded `reply_to` |
| `effect` | iMessage effect + inner part |
| `reaction` | tapback (or custom emoji) |
| `typing` | typing indicator |
| `rename` | group name update |
| `avatar` | group icon update |
| `contact` | shared as a `.vcf` media attachment |
| `group` | one message with multiple parts |
| `custom` | escape hatch (`raw` merged into the message body) |
| `poll` / `poll_option` | unsupported (LinQ has no polls) → `UnsupportedError` |
