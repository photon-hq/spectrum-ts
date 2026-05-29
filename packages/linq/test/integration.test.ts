import { describe, expect, it } from "bun:test";
import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import { type Message, Spectrum } from "spectrum-ts";
import { linq } from "../src/index";

// Encode the protobuf envelope Fusor POSTs: a RawInboundEvent whose rawRequest
// is the platform's original HTTP/1.1 wire bytes (headers + JSON body).
const encodeEvent = (httpBody: string): Uint8Array => {
  const wire = `POST /linq HTTP/1.1\r\ncontent-type: application/json\r\n\r\n${httpBody}`;
  return RawInboundEvent.encode(
    RawInboundEvent.create({
      eventId: "evt-int-1",
      projectId: "proj",
      platform: "linq",
      rawRequest: new TextEncoder().encode(wire),
    })
  ).finish();
};

const receivedTextEnvelope = (text: string): string =>
  JSON.stringify({
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: "evt-int-1",
    created_at: "2026-05-29T00:00:00Z",
    trace_id: "t",
    partner_id: "p",
    data: {
      id: "m-int-1",
      chat: { id: "chat-int-1" },
      direction: "inbound",
      parts: [{ type: "text", value: text }],
      sender_handle: {
        id: "u-int-1",
        handle: "+15551112222",
        joined_at: "2026-05-29T00:00:00Z",
        service: "iMessage",
        is_me: false,
      },
      service: "iMessage",
      sent_at: "2026-05-29T00:00:01Z",
    },
  });

describe("linq end-to-end via spectrum.webhook", () => {
  it("routes a LinQ message.received envelope to the handler as [space, message]", async () => {
    // No webhookSigningSecret → signature check is skipped for the smoke test.
    const app = await Spectrum({ providers: [linq.config({ apiKey: "k" })] });
    const received: Message[] = [];

    const result = await app.webhook(
      {
        headers: {},
        body: encodeEvent(receivedTextEnvelope("hello from linq")),
      },
      (space, message) => {
        expect(space.id).toBe("chat-int-1");
        expect(space.__platform).toBe("linq");
        received.push(message);
      }
    );

    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    const message = received[0];
    expect(message?.id).toBe("m-int-1");
    expect(message?.direction).toBe("inbound");
    expect(message?.platform).toBe("linq");
    expect(message?.content).toEqual({ type: "text", text: "hello from linq" });
    expect(message?.sender?.id).toBe("u-int-1");

    await app.stop();
  });

  it("returns 400 when the platform signature is wrong (poison, no retry)", async () => {
    const app = await Spectrum({
      providers: [
        linq.config({ apiKey: "k", webhookSigningSecret: "whsec_x" }),
      ],
    });

    const result = await app.webhook(
      {
        headers: {
          "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-webhook-signature": "deadbeef",
        },
        body: encodeEvent(receivedTextEnvelope("nope")),
      },
      () => undefined
    );

    expect(result.status).toBe(400);
    await app.stop();
  });
});
