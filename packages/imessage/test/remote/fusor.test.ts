import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { FusorTerminalError } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertVirtualImessageResources,
  handleImessageFusorMessages,
  verifyImessageFusorRequest,
} from "@/remote/fusor";
import { SHARED_PHONE } from "@/types";

// Encoded with advanced-imessage's v1 CatchUpEventsResponse codec. This is a
// small companion to fusor-fanin-imessage's exhaustive transformed golden and
// deliberately contains only project-scoped virtual message resources.
const RECEIVED_FRAME = Uint8Array.from(
  Buffer.from(
    "CCpSuwEKF2lNZXNzYWdlOy07KzE1NTUxMjM0NTY3EgwIi9vg0gYQgIS42QEaFAoMKzE1NTUxMjM0NTY3EAEaAlVTUnwKegoUc3BjLW1zZy1tZXNzYWdlLWd1aWQSEgoQaGVsbG8gZnJvbSBmdXNvclIMCIvb4NIGEICEuNkBogEUCgwrMTU1NTEyMzQ1NjcQARoCVVPaBA5wOisxNTU1MDAwMTExMeIFF2lNZXNzYWdlOy07KzE1NTUxMjM0NTY3",
    "base64"
  )
);

const request = (
  overrides: Partial<Parameters<typeof verifyImessageFusorRequest>[0]> = {}
) => ({
  method: "POST",
  path: "/imessage/events/messageChanged",
  headers: {
    "content-type": "application/x-protobuf",
    "x-fusor-imessage-event-type": "messageChanged",
    "x-fusor-imessage-instance-id": "instance-1",
    "x-fusor-imessage-log-id": "42",
    "x-fusor-imessage-transform-version": "2",
    "x-fusor-source": "spectrum-imessage",
  },
  rawBody: RECEIVED_FRAME,
  ...overrides,
});

const v1Request = () => {
  const base = request();
  const { "x-fusor-imessage-instance-id": _instanceId, ...headers } =
    base.headers;
  return request({
    headers: {
      ...headers,
      "x-fusor-imessage-transform-version": "1",
    },
  });
};

const v3Request = () =>
  request({
    headers: {
      ...request().headers,
      "x-fusor-imessage-transform-version": "3",
    },
  });

const client = (): AdvancedIMessage =>
  ({
    messages: {
      get: () => Promise.reject(new Error("not expected")),
    },
  }) as unknown as AdvancedIMessage;

describe("iMessage Fusor transport", () => {
  it("verifies and decodes the versioned fan-in contract", () => {
    const payload = verifyImessageFusorRequest(request());

    expect(payload.instanceId).toBe("instance-1");
    expect(payload.transformVersion).toBe("2");
    expect(payload.event).toMatchObject({
      chatGuid: "iMessage;-;+15551234567",
      isFromMe: false,
      message: {
        content: { text: "hello from fusor" },
        destinationCallerId: "p:+15550001111",
        guid: "spc-msg-message-guid",
        isFromMe: false,
      },
      sequence: 42,
      type: "message.received",
    });
  });

  it.each([
    ["method", request({ method: "GET" })],
    ["path", request({ path: "/imessage/events/other" })],
    [
      "content type",
      request({
        headers: { ...request().headers, "content-type": "application/json" },
      }),
    ],
    [
      "source",
      request({
        headers: { ...request().headers, "x-fusor-source": "public-ingress" },
      }),
    ],
    [
      "event type",
      request({
        headers: {
          ...request().headers,
          "x-fusor-imessage-event-type": "pollChanged",
        },
      }),
    ],
    [
      "transform version",
      request({
        headers: {
          ...request().headers,
          "x-fusor-imessage-transform-version": "4",
        },
      }),
    ],
    [
      "instance",
      request({
        headers: {
          ...request().headers,
          "x-fusor-imessage-instance-id": "",
        },
      }),
    ],
    [
      "sequence",
      request({
        headers: { ...request().headers, "x-fusor-imessage-log-id": "43" },
      }),
    ],
  ])("rejects an invalid %s contract", (_name, input) => {
    expect(() => verifyImessageFusorRequest(input)).toThrow();
  });

  it("accepts retained transform-v1 frames without an instance header", () => {
    const payload = verifyImessageFusorRequest(v1Request());

    expect(payload.instanceId).toBeUndefined();
    expect(payload.transformVersion).toBe("1");
    expect(payload.event.message.destinationCallerId).toBe("p:+15550001111");
  });

  it("accepts Spectrum-materialized transform-v3 frames", () => {
    const payload = verifyImessageFusorRequest(v3Request());

    expect(payload.instanceId).toBe("instance-1");
    expect(payload.transformVersion).toBe("3");
    expect(payload.event.sequence).toBe(42);
  });

  it("requires an instance header on transform-v3 frames", () => {
    const base = v3Request();

    expect(() =>
      verifyImessageFusorRequest({
        ...base,
        headers: {
          ...base.headers,
          "x-fusor-imessage-instance-id": "",
        },
      })
    ).toThrow("missing x-fusor-imessage-instance-id");
  });

  it("routes a dedicated event by its trusted instance id", async () => {
    const selected = client();
    const resourceClient = client();
    const other = client();
    const payload = verifyImessageFusorRequest(request());

    const records = await handleImessageFusorMessages({
      client: [
        { client: other, instanceId: "instance-2", phone: "+15550002222" },
        {
          client: selected,
          instanceId: "instance-1",
          phone: "+15550001111",
          resourceClient,
        },
      ],
      config: {},
      payload,
      projectConfig: undefined,
      respond: () => undefined,
      store: {} as never,
    });

    expect(records).toHaveLength(1);
    const record = Array.isArray(records) ? records[0] : records;
    expect(record).toMatchObject({
      content: { text: "hello from fusor", type: "text" },
      id: "spc-msg-message-guid",
      space: {
        id: "iMessage;-;+15551234567",
        phone: "+15550001111",
      },
    });
  });

  it("binds virtual inbound attachment reads to the Spectrum resource client", async () => {
    const directDownload = vi.fn();
    const resourceDownload = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { data: Uint8Array.from([1, 2, 3]), type: "primaryChunk" };
      },
      close: () => Promise.resolve(),
    }));
    const direct = {
      attachments: { downloadStream: directDownload },
    } as unknown as AdvancedIMessage;
    const resourceClient = {
      attachments: { downloadStream: resourceDownload },
      messages: { get: () => Promise.reject(new Error("not expected")) },
    } as unknown as AdvancedIMessage;
    const decoded = verifyImessageFusorRequest(request());
    const payload = {
      ...decoded,
      event: {
        ...decoded.event,
        message: {
          ...decoded.event.message,
          content: {
            ...decoded.event.message.content,
            attachments: [
              {
                fileName: "photo.png",
                guid: "spc-att-photo",
                isHidden: false,
                isOutgoing: false,
                isSticker: false,
                mimeType: "image/png",
                totalBytes: 3,
                transferState: 0,
                uti: "public.png",
              },
            ],
            text: "\uFFFC",
          },
        },
      },
    } as unknown as typeof decoded;

    const records = await handleImessageFusorMessages({
      client: [
        {
          client: direct,
          instanceId: "instance-1",
          phone: "+15550001111",
          resourceClient,
        },
      ],
      config: {},
      payload,
      projectConfig: undefined,
      respond: () => undefined,
      store: {} as never,
    });
    const record = Array.isArray(records) ? records[0] : records;
    if (record?.content.type !== "attachment") {
      throw new Error("expected an attachment record");
    }

    await expect(record.content.read()).resolves.toEqual(
      Buffer.from([1, 2, 3])
    );
    expect(resourceDownload).toHaveBeenCalledWith("spc-att-photo");
    expect(directDownload).not.toHaveBeenCalled();
  });

  it("resolves virtual reply targets through the Spectrum resource client", async () => {
    const decoded = verifyImessageFusorRequest(request());
    const getDirect = vi.fn(() => Promise.reject(new Error("wrong client")));
    const getResource = vi.fn(() =>
      Promise.resolve({
        ...decoded.event.message,
        content: {
          ...decoded.event.message.content,
          text: "original message",
        },
        guid: "spc-msg-reply-target",
      })
    );
    const payload = {
      ...decoded,
      event: {
        ...decoded.event,
        message: {
          ...decoded.event.message,
          replyTargetGuid: "spc-msg-reply-target",
        },
      },
    } as typeof decoded;

    const records = await handleImessageFusorMessages({
      client: [
        {
          client: {
            messages: { get: getDirect },
          } as unknown as AdvancedIMessage,
          instanceId: "instance-1",
          phone: "+15550001111",
          resourceClient: {
            messages: { get: getResource },
          } as unknown as AdvancedIMessage,
        },
      ],
      config: {},
      payload,
      projectConfig: undefined,
      respond: () => undefined,
      store: {} as never,
    });

    expect(Array.isArray(records) ? records[0]?.content.type : undefined).toBe(
      "reply"
    );
    expect(getResource).toHaveBeenCalledWith("spc-msg-reply-target");
    expect(getDirect).not.toHaveBeenCalled();
  });

  it("rejects a v2 instance whose configured phone disagrees with the payload", async () => {
    const payload = verifyImessageFusorRequest(request());

    await expect(
      handleImessageFusorMessages({
        client: [
          {
            client: client(),
            instanceId: "instance-1",
            phone: "+15550002222",
          },
        ],
        config: {},
        payload,
        projectConfig: undefined,
        respond: () => undefined,
        store: {} as never,
      })
    ).rejects.toMatchObject({
      name: "FusorTerminalError",
      message:
        "Fusor instance instance-1 does not serve destination +15550001111",
    });
  });

  it("uses the sole client in shared mode", async () => {
    const payload = verifyImessageFusorRequest(v1Request());
    const records = await handleImessageFusorMessages({
      client: [{ client: client(), phone: SHARED_PHONE }],
      config: {},
      payload,
      projectConfig: undefined,
      respond: () => undefined,
      store: {} as never,
    });

    const record = Array.isArray(records) ? records[0] : records;
    expect(record?.space).toMatchObject({ phone: SHARED_PHONE });
  });

  it("routes a retained transform-v1 frame by its destination phone", async () => {
    const selected = client();
    const payload = verifyImessageFusorRequest(v1Request());
    const records = await handleImessageFusorMessages({
      client: [
        { client: client(), phone: "+15550002222" },
        { client: selected, phone: "+15550001111" },
      ],
      config: {},
      payload,
      projectConfig: undefined,
      respond: () => undefined,
      store: {} as never,
    });

    const record = Array.isArray(records) ? records[0] : records;
    expect(record?.space).toMatchObject({ phone: "+15550001111" });
  });

  it("does not reassign a retained v1 frame for a removed line", async () => {
    const payload = verifyImessageFusorRequest(v1Request());

    await expect(
      handleImessageFusorMessages({
        client: [{ client: client(), phone: "+15550002222" }],
        config: {},
        payload,
        projectConfig: undefined,
        respond: () => undefined,
        store: {} as never,
      })
    ).rejects.toMatchObject({
      name: "FusorTerminalError",
      message:
        "Cannot route transform-v1 iMessage Fusor event to one dedicated client",
    });
  });

  it("uses the sole dedicated client for a destination-less v1 frame", async () => {
    const decoded = verifyImessageFusorRequest(v1Request());
    const { destinationCallerId: _destinationCallerId, ...message } =
      decoded.event.message;
    const payload = {
      ...decoded,
      event: { ...decoded.event, message },
    } as typeof decoded;
    const records = await handleImessageFusorMessages({
      client: [{ client: client(), phone: "+15550002222" }],
      config: {},
      payload,
      projectConfig: undefined,
      respond: () => undefined,
      store: {} as never,
    });

    const record = Array.isArray(records) ? records[0] : records;
    expect(record?.space).toMatchObject({ phone: "+15550002222" });
  });

  it("rejects an event for an unconfigured dedicated instance", async () => {
    const payload = verifyImessageFusorRequest(request());

    await expect(
      handleImessageFusorMessages({
        client: [
          {
            client: client(),
            instanceId: "instance-2",
            phone: "+15550002222",
          },
        ],
        config: {},
        payload,
        projectConfig: undefined,
        respond: () => undefined,
        store: {} as never,
      })
    ).rejects.toBeInstanceOf(FusorTerminalError);
  });

  it("rejects empty and nested unvirtualized resource ids", () => {
    const { event } = verifyImessageFusorRequest(request());
    const emptyGuidEvent = {
      ...event,
      message: { ...event.message, guid: "spc-msg-" },
    } as typeof event;
    expect(() => assertVirtualImessageResources(emptyGuidEvent)).toThrow(
      "message.guid"
    );

    const nestedEvent = {
      ...event,
      message: {
        ...event.message,
        appliedReactions: [{ messageGuid: "backend-message-guid" }],
      },
    } as unknown as typeof event;
    expect(() => assertVirtualImessageResources(nestedEvent)).toThrow(
      "message.appliedReactions[0].messageGuid"
    );
  });
});
