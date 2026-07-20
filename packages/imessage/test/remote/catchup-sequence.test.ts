import { decodeCatchUpEvent } from "@photon-ai/advanced-imessage/http";
import { describe, expect, it } from "vitest";
import {
  CatchUpSequenceError,
  inspectCatchUpSequence,
} from "@/remote/catchup-sequence";

const SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n;

const RECEIVED_FRAME = Uint8Array.from(
  Buffer.from(
    "CCpSuwEKF2lNZXNzYWdlOy07KzE1NTUxMjM0NTY3EgwIi9vg0gYQgIS42QEaFAoMKzE1NTUxMjM0NTY3EAEaAlVTUnwKegoUc3BjLW1zZy1tZXNzYWdlLWd1aWQSEgoQaGVsbG8gZnJvbSBmdXNvclIMCIvb4NIGEICEuNkBogEUCgwrMTU1NTEyMzQ1NjcQARoCVVPaBA5wOisxNTU1MDAwMTExMeIFF2lNZXNzYWdlOy07KzE1NTUxMjM0NTY3",
    "base64"
  )
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

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const frameWithSequence = (sequence: bigint): Uint8Array =>
  concat(Uint8Array.of(8), encodeVarint(sequence), RECEIVED_FRAME.subarray(2));

describe("inspectCatchUpSequence", () => {
  it("returns an exact bigint and canonical decimal without aliasing the body", () => {
    const result = inspectCatchUpSequence(RECEIVED_FRAME);

    expect(result.sequence).toBe(42n);
    expect(result.sequenceDecimal).toBe("42");
    expect(result.decoderBody).toEqual(RECEIVED_FRAME);
    expect(result.decoderBody).not.toBe(RECEIVED_FRAME);
  });

  it("supports signed INT64_MAX while protecting the number-based decoder", () => {
    const body = frameWithSequence(SIGNED_INT64_MAX);
    const original = Uint8Array.from(body);
    const result = inspectCatchUpSequence(body);

    expect(result.sequence).toBe(SIGNED_INT64_MAX);
    expect(result.sequenceDecimal).toBe("9223372036854775807");
    expect(body).toEqual(original);

    const expectedPrefix = concat(Uint8Array.of(8), encodeVarint(SAFE_INTEGER));
    expect(result.decoderBody.subarray(0, expectedPrefix.byteLength)).toEqual(
      expectedPrefix
    );
    expect(result.decoderBody.subarray(expectedPrefix.byteLength)).toEqual(
      RECEIVED_FRAME.subarray(2)
    );

    const decoded = decodeCatchUpEvent(result.decoderBody);
    expect(decoded?.type).toBe("message.received");
    if (decoded?.type !== "message.received") {
      throw new Error("expected a message.received event");
    }
    expect(decoded.sequence).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("accepts an explicitly encoded zero sequence", () => {
    const result = inspectCatchUpSequence(
      concat(Uint8Array.of(18, 0, 8, 0), Uint8Array.of(45, 1, 2, 3, 4))
    );

    expect(result.sequence).toBe(0n);
    expect(result.sequenceDecimal).toBe("0");
  });

  it.each([
    ["missing", Uint8Array.of(18, 0)],
    ["duplicate", Uint8Array.of(8, 1, 8, 2)],
    ["wrong wire type", Uint8Array.of(10, 0)],
    ["noncanonical value", Uint8Array.of(8, 129, 0)],
    ["noncanonical key", Uint8Array.of(136, 0, 1)],
    ["truncated sequence", Uint8Array.of(8, 128)],
    ["truncated trailing field", Uint8Array.of(8, 1, 18, 2, 255)],
    [
      "outside signed int64",
      concat(Uint8Array.of(8), encodeVarint(SIGNED_INT64_MAX + 1n)),
    ],
    [
      "uint64 overflow",
      Uint8Array.of(8, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2),
    ],
  ])("rejects a %s protobuf sequence", (_name, body) => {
    expect(() => inspectCatchUpSequence(body)).toThrow(CatchUpSequenceError);
  });
});
