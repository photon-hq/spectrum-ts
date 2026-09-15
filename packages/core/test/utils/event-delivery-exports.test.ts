import { describe, expect, it } from "vitest";
import {
  isExternalWebhookClient,
  isProviderEvent,
  providerEvent,
  webhookClient,
} from "@/index";
import { cloud } from "@/utils/cloud";

describe("public event delivery names", () => {
  it("creates external webhook clients and provider events through the public exports", async () => {
    const client = webhookClient("example", (request) => request.method);
    expect(isExternalWebhookClient(client)).toBe(true);
    expect(isExternalWebhookClient({ platform: "example" })).toBe(false);
    expect(
      await client.verify({
        method: "POST",
        path: "/example",
        headers: {},
        rawBody: new Uint8Array(),
      })
    ).toBe("POST");

    const event = providerEvent("presence", { online: true });
    expect(isProviderEvent(event)).toBe(true);
    expect(isProviderEvent({ name: "presence", data: {} })).toBe(false);
    expect(event.data).toEqual({ online: true });
    expect(cloud.issueEventDeliveryToken).toBeTypeOf("function");
  });

  it("does not export retired public names", async () => {
    const sdk = await import("@/index");
    for (const name of [
      "fusor",
      "isFusorClient",
      "fusorEvent",
      "isFusorEvent",
    ]) {
      expect(sdk).not.toHaveProperty(name);
    }
    expect(cloud).not.toHaveProperty("issueFusorToken");
  });
});
