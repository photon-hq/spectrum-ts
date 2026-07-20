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
const REACTION_FRAME = Uint8Array.from(
  Buffer.from(
    "CCtSWQoXaU1lc3NhZ2U7LTsrMTU1NTEyMzQ1NjcSCwiA4s+qBhDAqdM6GhQKDCsxNTU1NzY1NDMyMRABGgJVU3IbChNuYXRpdmUtbWVzc2FnZS1ndWlkEAIaAggB",
    "base64"
  )
);
const POLL_FRAME = Uint8Array.from(
  Buffer.from(
    "CCxiYgoXaU1lc3NhZ2U7KztuYXRpdmUtZ3JvdXASEG5hdGl2ZS1wb2xsLWd1aWQaCwiA4s+qBhDAqdM6IhQKDCsxNTU1NzY1NDMyMRABGgJVU2ISChBuYXRpdmUtb3B0aW9uLWlk",
    "base64"
  )
);
const GROUP_FRAME = Uint8Array.from(
  Buffer.from(
    "CC1aVAoXaU1lc3NhZ2U7KztuYXRpdmUtZ3JvdXASCwiA4s+qBhDAqdM6GhQKDCsxNTU1NzY1NDMyMRABGgJVU1oWChQKDCsxNTU1MDAwOTk5ORABGgJVUw==",
    "base64"
  )
);

type DedicatedEventType =
  | "groupChanged"
  | "messageChanged"
  | "pollChanged"
  | "reactionAdded";

const DEDICATED_FIXTURES: Readonly<
  Record<DedicatedEventType, { body: Uint8Array; sequence: string }>
> = {
  groupChanged: { body: GROUP_FRAME, sequence: "45" },
  messageChanged: { body: NATIVE_FRAME, sequence: "42" },
  pollChanged: { body: POLL_FRAME, sequence: "44" },
  reactionAdded: { body: REACTION_FRAME, sequence: "43" },
};

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
  if (body[0] !== 8 || (body[1] ?? 128) >= 128) {
    throw new Error("fixture no longer starts with a one-byte field 1");
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
  overrides: Partial<FusorVerifyRequest> = {},
  eventType: DedicatedEventType = "messageChanged"
): FusorVerifyRequest => {
  const fixture = DEDICATED_FIXTURES[eventType];
  return {
    method: "POST",
    path: `/imessage/events/${eventType}`,
    headers: {
      "content-type": "application/x-protobuf",
      "x-fusor-imessage-event-type": eventType,
      "x-fusor-imessage-line-id": LINE_ID,
      "x-fusor-imessage-phone": LINE_PHONE,
      "x-fusor-imessage-source-sequence": fixture.sequence,
      "x-fusor-imessage-transform-version": "4",
      "x-fusor-source": "fusor-fanin-imessage",
    },
    rawBody: fixture.body,
    ...overrides,
  };
};

const decodedFixture = (body: Uint8Array = NATIVE_FRAME): ReceivedEvent => {
  const event = decodeCatchUpEvent(body);
  if (event?.type !== "message.received") {
    throw new Error("expected a message.received fixture");
  }
  return event;
};

const decodeOnceAs = (
  event: NonNullable<ReturnType<typeof decodeCatchUpEvent>>
): void => {
  vi.mocked(decodeCatchUpEvent).mockReturnValueOnce(event);
};

type DedicatedReceivedPayload = Extract<
  ReturnType<typeof verifyImessageFusorRequest>,
  { kind: "dedicated" }
> & { event: ReceivedEvent };

const dedicatedReceivedPayload = (): DedicatedReceivedPayload => {
  const payload = verifyImessageFusorRequest(dedicatedRequest());
  if (
    payload.kind !== "dedicated" ||
    payload.event.type !== "message.received"
  ) {
    throw new Error("expected a dedicated message.received payload");
  }
  return payload as DedicatedReceivedPayload;
};

interface ClientSpies {
  client: AdvancedIMessage;
  downloadStream: ReturnType<typeof vi.fn>;
  getGroupIcon: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  getPoll: ReturnType<typeof vi.fn>;
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
  const getPoll =
    overrides.getPoll ??
    vi.fn(() => Promise.reject(new Error("poll lookup not expected")));
  const getGroupIcon =
    overrides.getGroupIcon ??
    vi.fn(() => Promise.reject(new Error("group icon lookup not expected")));
  const shareContactInfo =
    overrides.shareContactInfo ?? vi.fn(() => Promise.resolve());
  return {
    client: {
      attachments: { downloadStream },
      chats: { shareContactInfo },
      groups: { getIcon: getGroupIcon },
      messages: { get: getMessage },
      polls: { get: getPoll },
    } as unknown as AdvancedIMessage,
    downloadStream,
    getGroupIcon,
    getMessage,
    getPoll,
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

  it.each([
    ["reactionAdded", "message.reactionAdded", "43"],
    ["pollChanged", "poll.changed", "44"],
    ["groupChanged", "group.changed", "45"],
  ] as const)("decodes a golden dedicated %s frame only through its exact v4 contract", (eventType, decodedType, sourceSequence) => {
    const payload = verifyImessageFusorRequest(dedicatedRequest({}, eventType));

    expect(payload).toMatchObject({
      event: { type: decodedType },
      eventType,
      kind: "dedicated",
      lineId: LINE_ID,
      phone: LINE_PHONE,
      sourceSequence,
      transformVersion: "4",
    });
  });

  it("rejects a v4 event whose exact path/header kind disagrees with the protobuf", () => {
    const input = dedicatedRequest({}, "reactionAdded");
    expect(() =>
      verifyImessageFusorRequest({
        ...input,
        rawBody: withSequence(POLL_FRAME, 43n),
      })
    ).toThrow("event payload");
  });

  it("rejects chat-only and unknown v4 event kinds", () => {
    for (const eventType of ["chatChanged", "reactionRemoved"]) {
      const input = dedicatedRequest();
      expect(() =>
        verifyImessageFusorRequest({
          ...input,
          headers: {
            ...input.headers,
            "x-fusor-imessage-event-type": eventType,
          },
          path: `/imessage/events/${eventType}`,
        })
      ).toThrow("event type");
    }
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

  it("maps a native reaction through only the selected phone and preserves its public id", async () => {
    const base = decodedFixture();
    const getMessage = vi.fn(() =>
      Promise.resolve({
        ...base.message,
        content: { ...base.message.content, text: "reaction target" },
        guid: "native-message-guid",
      })
    );
    const selected = remoteClient({ getMessage });
    const other = remoteClient();
    const payload = verifyImessageFusorRequest(
      dedicatedRequest({}, "reactionAdded")
    );
    const records = await handle(
      [
        {
          client: other.client,
          phone: OTHER_PHONE,
        },
        { client: selected.client, phone: LINE_PHONE },
      ],
      payload,
      true
    );
    const record = Array.isArray(records) ? records[0] : records;

    expect(record).toMatchObject({
      id: "native-message-guid:reaction:43:2",
      space: {
        id: "iMessage;-;+15551234567",
        phone: LINE_PHONE,
      },
    });
    if (record?.content.type !== "reaction") {
      throw new Error("expected reaction content");
    }
    expect(record.content.target).toMatchObject({
      id: "native-message-guid",
      space: { phone: LINE_PHONE },
    });
    expect(record.space).not.toHaveProperty("lineId");
    expect(record.content.target.space).not.toHaveProperty("lineId");
    expect(selected.getMessage).toHaveBeenCalledWith("native-message-guid");
    expect(other.getMessage).not.toHaveBeenCalled();
    expect(selected.shareContactInfo).not.toHaveBeenCalled();
  });

  it("maps a native poll vote through only the selected phone", async () => {
    const getPoll = vi.fn(() =>
      Promise.resolve({
        chatGuid: "iMessage;+;native-group",
        options: [
          {
            optionIdentifier: "native-option-id",
            text: "Ship it",
          },
          {
            optionIdentifier: "native-option-id-2",
            text: "Wait",
          },
        ],
        pollMessageGuid: "native-poll-guid",
        title: "Release?",
        votes: [],
      })
    );
    const selected = remoteClient({ getPoll });
    const other = remoteClient();
    const payload = verifyImessageFusorRequest(
      dedicatedRequest({}, "pollChanged")
    );
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

    expect(record).toMatchObject({
      id: "native-poll-guid:+15557654321:native-option-id:selected:1700000000123",
      content: { selected: true, type: "poll_option" },
      space: {
        id: "iMessage;+;native-group",
        phone: LINE_PHONE,
      },
    });
    expect(record?.space).not.toHaveProperty("lineId");
    expect(selected.getPoll).toHaveBeenCalledWith("native-poll-guid");
    expect(other.getPoll).not.toHaveBeenCalled();
  });

  it("caches self-authored poll metadata before suppressing its echo", async () => {
    const selected = remoteClient();
    const vote = verifyImessageFusorRequest(
      dedicatedRequest({}, "pollChanged")
    );
    if (vote.kind !== "dedicated" || vote.event.type !== "poll.changed") {
      throw new Error("expected a dedicated poll change");
    }
    const created = {
      ...vote,
      event: {
        ...vote.event,
        actor: { address: LINE_PHONE, service: "iMessage" as const },
        delta: {
          options: [
            { optionIdentifier: "native-option-id", text: "Ship it" },
            { optionIdentifier: "native-option-id-2", text: "Wait" },
          ],
          title: "Release?",
          type: "created" as const,
        },
        isFromMe: true,
      },
    };
    const clients = [{ client: selected.client, phone: LINE_PHONE }];

    await expect(handle(clients, created)).resolves.toEqual([]);
    const records = await handle(clients, vote);

    expect(Array.isArray(records) ? records[0]?.content.type : undefined).toBe(
      "poll_option"
    );
    expect(selected.getPoll).not.toHaveBeenCalled();
  });

  it("maps a native group change with the pre-migration synthetic id", async () => {
    const selected = remoteClient();
    const payload = verifyImessageFusorRequest(
      dedicatedRequest({}, "groupChanged")
    );
    const records = await handle(
      [{ client: selected.client, phone: LINE_PHONE }],
      payload
    );

    expect(Array.isArray(records) ? records[0] : records).toMatchObject({
      id: "iMessage;+;native-group:group:45",
      content: { members: ["+15550009999"], type: "addMember" },
      space: {
        id: "iMessage;+;native-group",
        phone: LINE_PHONE,
      },
    });
    expect(
      Array.isArray(records) ? records[0]?.space : records?.space
    ).not.toHaveProperty("lineId");
  });

  it("uses the exact source sequence in supplemental ids above Number.MAX_SAFE_INTEGER", async () => {
    const groupInput = dedicatedRequest({}, "groupChanged");
    const groupPayload = verifyImessageFusorRequest({
      ...groupInput,
      headers: {
        ...groupInput.headers,
        "x-fusor-imessage-source-sequence": SIGNED_INT64_MAX.toString(),
      },
      rawBody: withSequence(GROUP_FRAME, SIGNED_INT64_MAX),
    });
    const groupClient = remoteClient();
    const groupRecords = await handle(
      [{ client: groupClient.client, phone: LINE_PHONE }],
      groupPayload
    );

    expect(
      Array.isArray(groupRecords) ? groupRecords[0]?.id : groupRecords?.id
    ).toBe(`iMessage;+;native-group:group:${SIGNED_INT64_MAX}`);

    const base = decodedFixture();
    const reactionClient = remoteClient({
      getMessage: vi.fn(() =>
        Promise.resolve({
          ...base.message,
          content: { ...base.message.content, text: "reaction target" },
          guid: "native-message-guid",
        })
      ),
    });
    const reactionInput = dedicatedRequest({}, "reactionAdded");
    const reactionPayload = verifyImessageFusorRequest({
      ...reactionInput,
      headers: {
        ...reactionInput.headers,
        "x-fusor-imessage-source-sequence": SIGNED_INT64_MAX.toString(),
      },
      rawBody: withSequence(REACTION_FRAME, SIGNED_INT64_MAX),
    });
    const reactionRecords = await handle(
      [{ client: reactionClient.client, phone: LINE_PHONE }],
      reactionPayload
    );

    expect(
      Array.isArray(reactionRecords)
        ? reactionRecords[0]?.id
        : reactionRecords?.id
    ).toBe(`native-message-guid:reaction:${SIGNED_INT64_MAX}:2`);
  });

  it("suppresses supplemental self echoes with the same dedicated-line rules as the old stream", async () => {
    const selected = remoteClient();

    const reaction = verifyImessageFusorRequest(
      dedicatedRequest({}, "reactionAdded")
    );
    if (
      reaction.kind !== "dedicated" ||
      reaction.event.type !== "message.reactionAdded"
    ) {
      throw new Error("expected a dedicated reaction");
    }
    await expect(
      handle([{ client: selected.client, phone: LINE_PHONE }], {
        ...reaction,
        event: { ...reaction.event, isFromMe: true },
      })
    ).resolves.toEqual([]);

    const poll = verifyImessageFusorRequest(
      dedicatedRequest({}, "pollChanged")
    );
    if (poll.kind !== "dedicated" || poll.event.type !== "poll.changed") {
      throw new Error("expected a dedicated poll change");
    }
    await expect(
      handle([{ client: selected.client, phone: LINE_PHONE }], {
        ...poll,
        event: {
          ...poll.event,
          actor: { address: LINE_PHONE, service: "iMessage" },
        },
      })
    ).resolves.toEqual([]);

    const group = verifyImessageFusorRequest(
      dedicatedRequest({}, "groupChanged")
    );
    if (group.kind !== "dedicated" || group.event.type !== "group.changed") {
      throw new Error("expected a dedicated group change");
    }
    await expect(
      handle([{ client: selected.client, phone: LINE_PHONE }], {
        ...group,
        event: {
          ...group.event,
          actor: undefined,
          change: {
            participant: { address: LINE_PHONE, service: "iMessage" },
            type: "participantLeft",
          },
        },
      })
    ).resolves.toEqual([]);

    expect(selected.getMessage).not.toHaveBeenCalled();
    expect(selected.getPoll).not.toHaveBeenCalled();
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
    const decoded = dedicatedReceivedPayload();
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
    const decoded = dedicatedReceivedPayload();
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
    const decoded = dedicatedReceivedPayload();
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

  it("accepts a received frame whose chat guid is carried only by the message", async () => {
    const fallbackChatGuid = "iMessage;-;+15557654321";
    const base = decodedFixture();
    decodeOnceAs({
      ...base,
      chatGuid: "",
      message: {
        ...base.message,
        chatGuids: [fallbackChatGuid],
      },
    });
    const payload = verifyImessageFusorRequest(dedicatedRequest());
    const selected = remoteClient();

    const records = await handle(
      [{ client: selected.client, phone: LINE_PHONE }],
      payload,
      true
    );

    expect(Array.isArray(records) ? records[0]?.space.id : undefined).toBe(
      fallbackChatGuid
    );
    expect(selected.shareContactInfo).toHaveBeenCalledWith(fallbackChatGuid);
  });

  it("shares a synced chat only after inbound conversion succeeds", async () => {
    const successful = remoteClient();
    const payload = dedicatedReceivedPayload();
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
