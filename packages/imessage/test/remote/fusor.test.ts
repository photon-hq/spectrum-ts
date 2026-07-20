import {
  type AdvancedIMessage,
  decodeCatchUpEvent,
} from "@photon-ai/advanced-imessage/http";
import { FusorTerminalError, type FusorVerifyRequest } from "@spectrum-ts/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertVirtualImessageResources,
  handleImessageFusorMessages,
  verifyImessageFusorRequest,
} from "@/remote/fusor";
import type { ReceivedEvent } from "@/remote/inbound";
import type { IMessageClient } from "@/types";
import { SHARED_PHONE } from "@/types";

vi.mock("@photon-ai/advanced-imessage/http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@photon-ai/advanced-imessage/http")>();
  return {
    ...actual,
    decodeCatchUpEvent: vi.fn(actual.decodeCatchUpEvent),
  };
});

// Encoded CatchUpEventsResponse containing a message.received event at
// sequence 42. Legacy uses its virtual message GUID as-is; dedicated replaces
// it with an equal-length native GUID without changing the protobuf shape.
const LEGACY_FRAME = Uint8Array.from(
  Buffer.from(
    "CCpSuwEKF2lNZXNzYWdlOy07KzE1NTUxMjM0NTY3EgwIi9vg0gYQgIS42QEaFAoMKzE1NTUxMjM0NTY3EAEaAlVTUnwKegoUc3BjLW1zZy1tZXNzYWdlLWd1aWQSEgoQaGVsbG8gZnJvbSBmdXNvclIMCIvb4NIGEICEuNkBogEUCgwrMTU1NTEyMzQ1NjcQARoCVVPaBA5wOisxNTU1MDAwMTExMeIFF2lNZXNzYWdlOy07KzE1NTUxMjM0NTY3",
    "base64"
  )
);
const LINE_ID = "c9e33ebd-162a-4db0-8e32-ca891dc86e1a";
const LINE_PHONE = "+15550001111";
const OTHER_PHONE = "+15550002222";
const NATIVE_MESSAGE_GUID = "native-guid-00000001";
const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n;

const replaceAscii = (
  body: Uint8Array,
  before: string,
  after: string
): Uint8Array => {
  const from = new TextEncoder().encode(before);
  const to = new TextEncoder().encode(after);
  if (from.byteLength !== to.byteLength) {
    throw new Error("protobuf string replacements must have equal lengths");
  }
  const result = Uint8Array.from(body);
  const index = result.findIndex((_, offset) =>
    from.every((byte, position) => result[offset + position] === byte)
  );
  if (index < 0) {
    throw new Error(`missing protobuf string ${before}`);
  }
  result.set(to, index);
  return result;
};

const NATIVE_FRAME = replaceAscii(
  LEGACY_FRAME,
  "spc-msg-message-guid",
  NATIVE_MESSAGE_GUID
);

const encodeVarint = (value: bigint): Uint8Array => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const payload = Number(remaining % 128n);
    remaining /= 128n;
    bytes.push(remaining === 0n ? payload : payload + 128);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
};

const withSequence = (body: Uint8Array, sequence: bigint): Uint8Array => {
  if (body[0] !== 8 || body[1] !== 42) {
    throw new Error("fixture no longer starts with sequence field 1 = 42");
  }
  const encoded = encodeVarint(sequence);
  const result = new Uint8Array(body.byteLength - 1 + encoded.byteLength);
  result[0] = 8;
  result.set(encoded, 1);
  result.set(body.subarray(2), 1 + encoded.byteLength);
  return result;
};

const legacyRequest = (
  version: "1" | "2" | "3" = "2",
  overrides: Partial<FusorVerifyRequest> = {}
): FusorVerifyRequest => {
  const headers: Record<string, string> = {
    "content-type": "application/x-protobuf",
    "x-fusor-imessage-event-type": "messageChanged",
    "x-fusor-imessage-log-id": "42",
    "x-fusor-imessage-transform-version": version,
    "x-fusor-source": "spectrum-imessage",
  };
  if (version !== "1") {
    headers["x-fusor-imessage-instance-id"] = "instance-1";
  }
  return {
    method: "POST",
    path: "/imessage/events/messageChanged",
    headers,
    rawBody: LEGACY_FRAME,
    ...overrides,
  };
};

const dedicatedRequest = (
  overrides: Partial<FusorVerifyRequest> = {}
): FusorVerifyRequest => ({
  method: "POST",
  path: "/imessage/events/messageChanged",
  headers: {
    "content-type": "application/x-protobuf",
    "x-fusor-imessage-event-type": "messageChanged",
    "x-fusor-imessage-line-id": LINE_ID,
    "x-fusor-imessage-phone": LINE_PHONE,
    "x-fusor-imessage-source-sequence": "42",
    "x-fusor-imessage-transform-version": "4",
    "x-fusor-source": "fusor-fanin-imessage",
  },
  rawBody: NATIVE_FRAME,
  ...overrides,
});

const decodedFixture = (body: Uint8Array = NATIVE_FRAME): ReceivedEvent => {
  const event = decodeCatchUpEvent(body);
  if (event?.type !== "message.received") {
    throw new Error("expected a message.received fixture");
  }
  return event;
};

const decodeOnceAs = (event: ReceivedEvent): void => {
  vi.mocked(decodeCatchUpEvent).mockReturnValueOnce(event);
};

interface ClientSpies {
  client: AdvancedIMessage;
  downloadStream: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  shareContactInfo: ReturnType<typeof vi.fn>;
}

const remoteClient = (overrides: Partial<ClientSpies> = {}): ClientSpies => {
  const downloadStream =
    overrides.downloadStream ??
    vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          data: Uint8Array.from([1, 2, 3]),
          type: "primaryChunk" as const,
        };
      },
      close: () => Promise.resolve(),
    }));
  const getMessage =
    overrides.getMessage ??
    vi.fn(() => Promise.reject(new Error("message lookup not expected")));
  const shareContactInfo =
    overrides.shareContactInfo ?? vi.fn(() => Promise.resolve());
  return {
    client: {
      attachments: { downloadStream },
      chats: { shareContactInfo },
      messages: { get: getMessage },
    } as unknown as AdvancedIMessage,
    downloadStream,
    getMessage,
    shareContactInfo,
  };
};

const handle = async (
  clients: IMessageClient,
  payload: ReturnType<typeof verifyImessageFusorRequest>,
  synced = false
) =>
  await handleImessageFusorMessages({
    client: clients,
    config: {},
    payload,
    projectConfig: synced
      ? {
          id: "project-1",
          name: "Project",
          profile: { imessageSynced: true },
          slug: "project",
        }
      : undefined,
    respond: () => undefined,
    store: {} as never,
  });

afterEach(() => {
  vi.clearAllMocks();
});

describe("iMessage Fusor request verification", () => {
  it.each([
    "1",
    "2",
    "3",
  ] as const)("accepts legacy transform-v%s virtual frames", (version) => {
    const payload = verifyImessageFusorRequest(legacyRequest(version));

    expect(payload).toMatchObject({
      kind: "legacy",
      sourceSequence: "42",
      transformVersion: version,
    });
    if (payload.kind !== "legacy") {
      throw new Error("expected legacy payload");
    }
    expect(payload.instanceId).toBe(version === "1" ? undefined : "instance-1");
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

  it("requires physical instance identity for retained v2 and v3 only", () => {
    for (const version of ["2", "3"] as const) {
      const input = legacyRequest(version);
      expect(() =>
        verifyImessageFusorRequest({
          ...input,
          headers: {
            ...input.headers,
            "x-fusor-imessage-instance-id": "",
          },
        })
      ).toThrow("missing x-fusor-imessage-instance-id");
    }
    const v1 = legacyRequest("1");
    expect(verifyImessageFusorRequest(v1)).toMatchObject({
      instanceId: undefined,
      transformVersion: "1",
    });
  });

  it("rejects unvirtualized legacy message and nested resource ids", () => {
    expect(() =>
      verifyImessageFusorRequest({
        ...legacyRequest(),
        rawBody: NATIVE_FRAME,
      })
    ).toThrow("message.guid is not a virtual resource");

    const event = decodedFixture(LEGACY_FRAME);
    const invalidEvents: [ReceivedEvent, string][] = [
      [
        {
          ...event,
          message: { ...event.message, replyTargetGuid: "native-reply" },
        },
        "message.replyTargetGuid",
      ],
      [
        {
          ...event,
          message: {
            ...event.message,
            content: {
              ...event.message.content,
              attachments: [
                {
                  fileName: "photo.png",
                  guid: "native-attachment",
                  isHidden: false,
                  isOutgoing: false,
                  isSticker: false,
                  mimeType: "image/png",
                  totalBytes: 3,
                  transferState: 0,
                  uti: "public.png",
                },
              ],
            },
          },
        } as unknown as ReceivedEvent,
        "message.content.attachments[0].guid",
      ],
      [
        {
          ...event,
          message: {
            ...event.message,
            appliedReactions: [{ messageGuid: "native-reaction-target" }],
          },
        } as unknown as ReceivedEvent,
        "message.appliedReactions[0].messageGuid",
      ],
      [
        {
          ...event,
          message: {
            ...event.message,
            placedStickers: [{ messageGuid: "native-sticker-target", part: 0 }],
          },
        } as unknown as ReceivedEvent,
        "message.placedStickers[0].messageGuid",
      ],
    ];

    for (const [invalid, field] of invalidEvents) {
      expect(() => assertVirtualImessageResources(invalid)).toThrow(field);
    }
  });

  it("accepts the dedicated v4 contract with native GUIDs and no instance", () => {
    const payload = verifyImessageFusorRequest(dedicatedRequest());

    expect(payload).toMatchObject({
      kind: "dedicated",
      lineId: LINE_ID,
      phone: LINE_PHONE,
      sourceSequence: "42",
      transformVersion: "4",
    });
    expect(payload.event).toMatchObject({
      message: {
        destinationCallerId: `p:${LINE_PHONE}`,
        guid: NATIVE_MESSAGE_GUID,
      },
      type: "message.received",
    });
  });

  it("keeps an exact signed-int64 sequence above Number.MAX_SAFE_INTEGER", () => {
    const rawBody = withSequence(NATIVE_FRAME, SIGNED_INT64_MAX);
    const payload = verifyImessageFusorRequest({
      ...dedicatedRequest(),
      headers: {
        ...dedicatedRequest().headers,
        "x-fusor-imessage-source-sequence": SIGNED_INT64_MAX.toString(),
      },
      rawBody,
    });

    expect(payload.sourceSequence).toBe(SIGNED_INT64_MAX.toString());
    // advanced-imessage is number-based; verification substitutes only its
    // decoder copy while retaining the exact cursor as a decimal string.
    expect(payload.event.sequence).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects normal and unsafe body/header sequence mismatches", () => {
    expect(() =>
      verifyImessageFusorRequest({
        ...dedicatedRequest(),
        headers: {
          ...dedicatedRequest().headers,
          "x-fusor-imessage-source-sequence": "43",
        },
      })
    ).toThrow("sequence mismatch");

    const rawBody = withSequence(NATIVE_FRAME, SIGNED_INT64_MAX);
    expect(() =>
      verifyImessageFusorRequest({
        ...dedicatedRequest(),
        headers: {
          ...dedicatedRequest().headers,
          "x-fusor-imessage-source-sequence": (
            SIGNED_INT64_MAX - 1n
          ).toString(),
        },
        rawBody,
      })
    ).toThrow("sequence mismatch");
  });

  it.each([
    ["line", "x-fusor-imessage-line-id", "not-a-uuid"],
    ["phone", "x-fusor-imessage-phone", "15550001111"],
    ["sequence zero", "x-fusor-imessage-source-sequence", "0"],
    ["sequence sign", "x-fusor-imessage-source-sequence", "+42"],
    ["sequence leading zero", "x-fusor-imessage-source-sequence", "042"],
    ["sequence whitespace", "x-fusor-imessage-source-sequence", " 42"],
    ["sequence decimal", "x-fusor-imessage-source-sequence", "42.0"],
  ])("rejects malformed dedicated %s headers", (_name, key, value) => {
    const input = dedicatedRequest();
    expect(() =>
      verifyImessageFusorRequest({
        ...input,
        headers: { ...input.headers, [key]: value },
      })
    ).toThrow();
  });

  it.each([
    "x-fusor-imessage-line-id",
    "x-fusor-imessage-phone",
    "x-fusor-imessage-source-sequence",
  ])("requires dedicated header %s", (key) => {
    const input = dedicatedRequest();
    expect(() =>
      verifyImessageFusorRequest({
        ...input,
        headers: { ...input.headers, [key]: "" },
      })
    ).toThrow(`missing ${key}`);
  });

  it("forbids a physical instance id on dedicated v4", () => {
    const input = dedicatedRequest();
    expect(() =>
      verifyImessageFusorRequest({
        ...input,
        headers: {
          ...input.headers,
          "x-fusor-imessage-instance-id": "physical-mac-id",
        },
      })
    ).toThrow("physical instance id is forbidden");
  });

  it.each([
    ["spectrum-imessage", "4"],
    ["fusor-fanin-imessage", "1"],
    ["fusor-fanin-imessage", "2"],
    ["fusor-fanin-imessage", "3"],
    ["public-ingress", "4"],
  ])("rejects source %s paired with transform %s", (source, version) => {
    const base = version === "4" ? dedicatedRequest() : legacyRequest("1");
    expect(() =>
      verifyImessageFusorRequest({
        ...base,
        headers: {
          ...base.headers,
          "x-fusor-imessage-transform-version": version,
          "x-fusor-source": source,
        },
      })
    ).toThrow("source and transform version pair");
  });

  it.each([
    ["method", { method: "GET" }],
    ["path", { path: "/imessage/events/other" }],
    [
      "content type",
      {
        headers: {
          ...dedicatedRequest().headers,
          "content-type": "application/json",
        },
      },
    ],
    [
      "event type",
      {
        headers: {
          ...dedicatedRequest().headers,
          "x-fusor-imessage-event-type": "pollChanged",
        },
      },
    ],
  ] as const)("rejects an invalid %s contract", (_name, overrides) => {
    expect(() =>
      verifyImessageFusorRequest(
        dedicatedRequest(overrides as Partial<FusorVerifyRequest>)
      )
    ).toThrow();
  });

  it("accepts only exact destination identity after optional p: removal", () => {
    for (const destinationCallerId of [LINE_PHONE, `p:${LINE_PHONE}`]) {
      const event = decodedFixture();
      decodeOnceAs({
        ...event,
        message: { ...event.message, destinationCallerId },
      });
      expect(verifyImessageFusorRequest(dedicatedRequest())).toMatchObject({
        phone: LINE_PHONE,
      });
    }

    for (const destinationCallerId of [
      `tel:${LINE_PHONE}`,
      `p:p:${LINE_PHONE}`,
      `${LINE_PHONE} `,
    ]) {
      const event = decodedFixture();
      decodeOnceAs({
        ...event,
        message: { ...event.message, destinationCallerId },
      });
      expect(() => verifyImessageFusorRequest(dedicatedRequest())).toThrow(
        `destination ${destinationCallerId.startsWith("p:") ? destinationCallerId.slice(2) : destinationCallerId}`
      );
    }
  });

  it.each([
    "event",
    "message",
  ] as const)("rejects an outbound %s flag", (level) => {
    const event = decodedFixture();
    decodeOnceAs(
      level === "event"
        ? { ...event, isFromMe: true }
        : { ...event, message: { ...event.message, isFromMe: true } }
    );

    expect(() => verifyImessageFusorRequest(dedicatedRequest())).toThrow(
      "outbound message"
    );
  });
});

describe("iMessage Fusor delivery routing", () => {
  it.each([
    "1",
    "2",
    "3",
  ] as const)("routes legacy transform-v%s only through shared mode", async (version) => {
    const shared = remoteClient();
    const payload = verifyImessageFusorRequest(legacyRequest(version));
    const records = await handle(
      [{ client: shared.client, phone: SHARED_PHONE }],
      payload
    );

    expect(records).toHaveLength(1);
    expect(Array.isArray(records) ? records[0] : records).toMatchObject({
      content: { text: "hello from fusor", type: "text" },
      id: "spc-msg-message-guid",
      space: {
        id: "iMessage;-;+15551234567",
        phone: SHARED_PHONE,
      },
    });
  });

  it.each([
    "1",
    "2",
    "3",
  ] as const)("terminal-fails legacy transform-v%s in dedicated mode", async (version) => {
    const dedicated = remoteClient();
    const payload = verifyImessageFusorRequest(legacyRequest(version));

    await expect(
      handle(
        [
          {
            client: dedicated.client,
            phone: LINE_PHONE,
          },
        ],
        payload
      )
    ).rejects.toEqual(
      new FusorTerminalError(
        "Legacy virtual iMessage events require shared mode"
      )
    );
  });

  it("selects a dedicated client by its stable phone", async () => {
    const wrongPhone = remoteClient();
    const selected = remoteClient();
    const payload = verifyImessageFusorRequest(dedicatedRequest());
    const records = await handle(
      [
        {
          client: wrongPhone.client,
          phone: OTHER_PHONE,
        },
        { client: selected.client, phone: LINE_PHONE },
      ],
      payload
    );

    expect(records).toHaveLength(1);
    expect(Array.isArray(records) ? records[0] : records).toMatchObject({
      id: NATIVE_MESSAGE_GUID,
      space: {
        id: "iMessage;-;+15551234567",
        phone: LINE_PHONE,
      },
    });
  });

  it("terminal-fails a missing dedicated phone route", async () => {
    const other = remoteClient();
    const payload = verifyImessageFusorRequest(dedicatedRequest());

    await expect(
      handle([{ client: other.client, phone: OTHER_PHONE }], payload)
    ).rejects.toMatchObject({
      message: `No iMessage client serves Fusor phone ${LINE_PHONE}`,
      name: "FusorTerminalError",
    });
  });

  it("terminal-fails dedicated v4 in shared mode", async () => {
    const shared = remoteClient();
    const payload = verifyImessageFusorRequest(dedicatedRequest());

    await expect(
      handle([{ client: shared.client, phone: SHARED_PHONE }], payload)
    ).rejects.toEqual(
      new FusorTerminalError(
        `Dedicated iMessage line ${LINE_ID} cannot use shared mode`
      )
    );
  });

  it("puts the dedicated phone on every returned multipart space", async () => {
    const selected = remoteClient();
    const decoded = verifyImessageFusorRequest(dedicatedRequest());
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
                guid: "native-att-id",
                isHidden: false,
                isOutgoing: false,
                isSticker: false,
                mimeType: "image/png",
                totalBytes: 3,
                transferState: 0,
                uti: "public.png",
              },
            ],
            text: "caption\uFFFC",
          },
        },
      },
    } as unknown as typeof decoded;
    const records = await handle(
      [{ client: selected.client, phone: LINE_PHONE }],
      payload
    );
    const record = Array.isArray(records) ? records[0] : records;

    expect(record?.space).toMatchObject({ phone: LINE_PHONE });
    if (record?.content.type !== "group") {
      throw new Error("expected multipart group");
    }
    expect(record.content.items).toHaveLength(2);
    for (const item of record.content.items) {
      expect(item.space).toMatchObject({ phone: LINE_PHONE });
    }
  });

  it("reads a native attachment through only the selected HTTP client", async () => {
    const selected = remoteClient();
    const other = remoteClient();
    const decoded = verifyImessageFusorRequest(dedicatedRequest());
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
                guid: "native-att-id",
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
    const records = await handle(
      [
        {
          client: other.client,
          phone: OTHER_PHONE,
        },
        { client: selected.client, phone: LINE_PHONE },
      ],
      payload
    );
    const record = Array.isArray(records) ? records[0] : records;
    if (record?.content.type !== "attachment") {
      throw new Error("expected an attachment record");
    }

    await expect(record.content.read()).resolves.toEqual(
      Buffer.from([1, 2, 3])
    );
    expect(selected.downloadStream).toHaveBeenCalledWith("native-att-id");
    expect(other.downloadStream).not.toHaveBeenCalled();
  });

  it("resolves a native reply target through only the selected HTTP client", async () => {
    const base = decodedFixture();
    const selectedGet = vi.fn(() =>
      Promise.resolve({
        ...base.message,
        content: { ...base.message.content, text: "original message" },
        guid: "native-reply-guid",
      })
    );
    const selected = remoteClient({ getMessage: selectedGet });
    const other = remoteClient();
    const decoded = verifyImessageFusorRequest(dedicatedRequest());
    const payload = {
      ...decoded,
      event: {
        ...decoded.event,
        message: {
          ...decoded.event.message,
          replyTargetGuid: "native-reply-guid",
        },
      },
    } as typeof decoded;
    const records = await handle(
      [
        {
          client: other.client,
          phone: OTHER_PHONE,
        },
        { client: selected.client, phone: LINE_PHONE },
      ],
      payload
    );

    expect(Array.isArray(records) ? records[0]?.content.type : undefined).toBe(
      "reply"
    );
    expect(selected.getMessage).toHaveBeenCalledWith("native-reply-guid");
    expect(other.getMessage).not.toHaveBeenCalled();
  });

  it("shares a synced chat only after inbound conversion succeeds", async () => {
    const successful = remoteClient();
    const payload = verifyImessageFusorRequest(dedicatedRequest());
    await handle(
      [
        {
          client: successful.client,
          phone: LINE_PHONE,
        },
      ],
      payload,
      true
    );
    expect(successful.shareContactInfo).toHaveBeenCalledOnce();
    expect(successful.shareContactInfo).toHaveBeenCalledWith(
      payload.event.chatGuid
    );

    const failing = remoteClient();
    const invalidPayload = {
      ...payload,
      event: {
        ...payload.event,
        message: {
          ...payload.event.message,
          content: {
            ...payload.event.message.content,
            attachments: undefined,
          },
        },
      },
    } as unknown as typeof payload;
    await expect(
      handle(
        [
          {
            client: failing.client,
            phone: LINE_PHONE,
          },
        ],
        invalidPayload,
        true
      )
    ).rejects.toThrow();
    expect(failing.shareContactInfo).not.toHaveBeenCalled();
  });
});
