import { afterEach, describe, expect, it, vi } from "vitest";
import { cloud, SPECTRUM_CLOUD_URL } from "@/utils/cloud";

const PROJECT_ID = "project/with path";
const PROJECT_SECRET = "project-secret";
const WEBHOOK_ID = "webhook-id";

interface FetchCall {
  init: RequestInit | undefined;
  url: string;
}

const mockCloud = (data: unknown): FetchCall[] => {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({ init, url: String(input) });
    return new Response(JSON.stringify({ data, succeed: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch);
  return calls;
};

const requestHeaders = (call: FetchCall): Headers =>
  new Headers(call.init?.headers);

const requestPath = (call: FetchCall | undefined): string =>
  new URL(call?.url ?? SPECTRUM_CLOUD_URL).pathname;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cloud Standard Webhooks API", () => {
  it("registers a webhook and returns both one-time secrets", async () => {
    const created = {
      createdAt: "2026-08-03T20:00:00.000Z",
      deliveryMode: "fusor" as const,
      disabledAt: null,
      disabledReason: null,
      enabled: true,
      eventTypes: ["message.received" as const],
      failureNotificationEmail: "alerts@example.com",
      id: WEBHOOK_ID,
      signingSecret: "legacy-secret",
      standardSigningSecret: "whsec_standard-secret",
      status: "active" as const,
      updatedAt: "2026-08-03T20:00:00.000Z",
      webhookUrl: "https://example.com/webhooks/spectrum",
    };
    const calls = mockCloud(created);

    const result = await cloud.createWebhook(PROJECT_ID, PROJECT_SECRET, {
      eventTypes: ["message.received"],
      failureNotificationEmail: "alerts@example.com",
      webhookUrl: created.webhookUrl,
    });

    expect(result).toEqual(created);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(
      `${SPECTRUM_CLOUD_URL}/projects/project%2Fwith%20path/webhooks/`
    );
    expect(call?.init?.method).toBe("POST");
    expect(requestHeaders(call as FetchCall).get("authorization")).toBe(
      `Basic ${btoa(`${PROJECT_ID}:${PROJECT_SECRET}`)}`
    );
    expect(requestHeaders(call as FetchCall).get("content-type")).toBe(
      "application/json"
    );
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      eventTypes: ["message.received"],
      failureNotificationEmail: "alerts@example.com",
      webhookUrl: created.webhookUrl,
    });
  });

  it("maps endpoint controls, rotation, egress, and deletion", async () => {
    const calls = mockCloud({});

    await cloud.listWebhooks(PROJECT_ID, PROJECT_SECRET);
    await cloud.updateWebhook(PROJECT_ID, PROJECT_SECRET, WEBHOOK_ID, {
      enabled: false,
      failureNotificationEmail: null,
    });
    await cloud.rotateWebhookSecret(PROJECT_ID, PROJECT_SECRET, WEBHOOK_ID, {
      overlapSeconds: 3600,
    });
    await cloud.getWebhookEgressIps(PROJECT_ID, PROJECT_SECRET);
    await cloud.deleteWebhook(PROJECT_ID, PROJECT_SECRET, WEBHOOK_ID);

    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.init?.method ?? "GET")).toEqual([
      "GET",
      "PATCH",
      "POST",
      "GET",
      "DELETE",
    ]);
    expect(calls[0]?.url).toBe(
      `${SPECTRUM_CLOUD_URL}/projects/project%2Fwith%20path/webhooks/`
    );
    expect(requestPath(calls[1])).toBe(
      "/projects/project%2Fwith%20path/webhooks/webhook-id"
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      enabled: false,
      failureNotificationEmail: null,
    });
    expect(requestPath(calls[2])).toBe(
      "/projects/project%2Fwith%20path/webhooks/webhook-id/secret/rotate"
    );
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      overlapSeconds: 3600,
    });
    expect(requestPath(calls[3])).toBe(
      "/projects/project%2Fwith%20path/webhooks/egress-ips"
    );

    expect(requestPath(calls[4])).toBe(
      "/projects/project%2Fwith%20path/webhooks/webhook-id"
    );

    for (const call of calls) {
      expect(requestHeaders(call).get("authorization")).toBe(
        `Basic ${btoa(`${PROJECT_ID}:${PROJECT_SECRET}`)}`
      );
    }
  });
});
