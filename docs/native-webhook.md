# Native Spectrum webhooks

Spectrum Cloud can **POST already-normalized, signed JSON** to your HTTPS
endpoint — Spectrum's own message model (`text`, `attachment`, `contact`,
`richlink`, `reaction`, `group`), with raw bytes and SDK methods stripped, signed
with an HMAC. This is the webhook documented at
<https://photon.codes/docs/webhooks>.

It's a different wire format from the [Fusor webhook](./fusor.md#webhook-mode--appwebhook),
which relays a **raw** provider request inside a protobuf envelope. You don't pick
one: **`app.webhook()` handles both**, auto-detecting per request and handing your
handler the same `(space, message)` pair either way.

| | Native Spectrum webhook | Fusor webhook |
|---|---|---|
| Body | signed, normalized JSON | protobuf envelope (raw provider request) |
| Auth | HMAC over the body, verified with your `webhookSecret` | the platform's own signature, via the provider `verify()` |
| Detection | JSON body (`{…`) | protobuf body |
| Works without a fusor provider | ✅ | ❌ (needs the fusor provider) |

## Configure the signing secret

When you register a webhook URL with Spectrum, you receive a **signing secret
once**. Give it to the SDK so deliveries can be verified:

```typescript
const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config()],
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET, // the per-webhook secret
});
```

`webhookSecret` may also be supplied via the `SPECTRUM_WEBHOOK_SECRET` environment
variable (the explicit option wins). A native delivery that arrives without a
configured secret is answered `500` and logged — it's a setup error, not an
attacker.

> The secret is shown only once at registration and cannot be fetched back. If you
> lose it, rotate it (delete + re-register) and update `webhookSecret`.

## Receive deliveries

Exactly the same call as the fusor webhook — there's nothing format-specific in
your code:

```typescript
// Hono / Bun.serve / Next.js / Workers — c.req.raw is a Web Request
server.post("/spectrum-webhook", (c) =>
  app.webhook(c.req.raw, async (space, message) => {
    if (message.content.type === "text") {
      await space.send(`echo: ${message.content.text}`);
    }
  })
);
```

```typescript
// Express / raw Node — pass the RAW body bytes + headers
app.post(
  "/spectrum-webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const result = await app.webhook(
      { body: req.body, headers: req.headers },
      async (space, message) => {
        /* … */
      }
    );
    res.status(result.status).set(result.headers).send(result.body);
  }
);
```

> ⚠️ **Pass the raw body bytes.** The HMAC is computed over the exact bytes on the
> wire. If your framework parses the body to JSON and you re-stringify it before
> the SDK sees it, the bytes change and verification fails. Use `c.req.raw` /
> `express.raw(...)` — never `req.json()`.

> 🔌 **First-party plugins** mount the endpoint for you in one call, with the
> raw-body handling already correct: **[`@spectrum-ts/hono`](./hono.md)**,
> **[`@spectrum-ts/express`](./express.md)**, and
> **[`@spectrum-ts/elysia`](./elysia.md)** (Elysia auto-parses JSON bodies, so the
> plugin disables parsing on its route and forwards the raw request).

## What the SDK does for you

- **Verifies the signature** — `HMAC-SHA256` over `v0:<timestamp>:<rawBody>`,
  constant-time compared, with a 5-minute replay window. A bad signature → `401`,
  an expired timestamp → `401`, a missing signature header → `400`. The handler is
  never dispatched on a failed verification.
- **Deserializes** the slim JSON into the normal `Message`/`Space`, including
  reaction targets and album (`group`) items.
- **Rehydrates attachments** — the webhook carries metadata only. `message.content`
  exposes `name`/`mimeType`/`size` immediately; `read()`/`stream()` fetch the bytes
  lazily via the platform (e.g. iMessage's `getAttachment`). On a platform without
  that capability, `read()` rejects with a clear error.

## Status codes & delivery semantics

`app.webhook()` returns `200` once a native delivery is verified and accepted; the
handler then runs **fire-and-forget** (after the response, not awaited — a throw is
logged, never surfaced). Unknown event types and messages for platforms you haven't
configured are acknowledged with `200` (a retry wouldn't help) and logged.

Spectrum delivers **at-least-once** and retries non-2xx responses, so dedupe on
`message.id` (optionally combined with the `X-Spectrum-Webhook-Id` header) for
exactly-once side effects.

Like the fusor webhook, this path is stateless and request-scoped: it does **not**
feed `app.messages`, and it never opens the streaming connection. See
[Keeping handler work alive](./fusor.md#keeping-handler-work-alive) for the
serverless caveat.

## Reference

- `app.webhook(request, handler)` — `src/spectrum.ts`
- Signature verification — `src/webhook/verify.ts`
- Slim-JSON deserialization — `src/webhook/deserialize.ts`
- Wire schemas — `src/webhook/types.ts`
