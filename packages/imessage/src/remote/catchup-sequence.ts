const UINT64_MAX = 18_446_744_073_709_551_615n;
const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_FIELD_NUMBER = 536_870_911n;
const UINT32_MAX = 4_294_967_295n;
const SAFE_DECODER_SEQUENCE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_GROUP_DEPTH = 64;

interface ParsedVarint {
  end: number;
  value: bigint;
}

interface ParsedFieldKey {
  end: number;
  fieldNumber: number;
  wireType: number;
}

interface SequenceField {
  value: bigint;
  valueEnd: number;
  valueStart: number;
}

export interface CatchUpSequenceInspection {
  /** A body that the number-based advanced-imessage decoder can read exactly. */
  decoderBody: Uint8Array;
  /** The exact unsigned protobuf value, constrained to the source's int64 range. */
  sequence: bigint;
  /** The exact canonical base-10 representation used by the transport header. */
  sequenceDecimal: string;
}

export class CatchUpSequenceError extends Error {
  constructor(reason: string) {
    super(`Invalid CatchUpEventsResponse sequence: ${reason}`);
    this.name = "CatchUpSequenceError";
  }
}

const fail = (reason: string): never => {
  throw new CatchUpSequenceError(reason);
};

const readCanonicalVarint = (
  body: Uint8Array,
  start: number,
  maximum: bigint,
  label: string
): ParsedVarint => {
  let cursor = start;
  let factor = 1n;
  let value = 0n;

  for (let index = 0; index < 10; index += 1) {
    const byte = body[cursor] ?? fail(`${label} is truncated`);
    cursor += 1;

    const payload = BigInt(byte % 128);
    value += payload * factor;
    if (byte < 128) {
      if (index > 0 && payload === 0n) {
        fail(`${label} is not canonical`);
      }
      if (value > maximum) {
        fail(`${label} is out of range`);
      }
      return { end: cursor, value };
    }
    factor *= 128n;
  }

  return fail(`${label} exceeds uint64`);
};

const readFieldKey = (body: Uint8Array, start: number): ParsedFieldKey => {
  const key = readCanonicalVarint(body, start, UINT32_MAX, "field key");
  const fieldNumber = key.value / 8n;
  const wireType = Number(key.value % 8n);

  if (fieldNumber === 0n || fieldNumber > MAX_FIELD_NUMBER) {
    fail("field key has an invalid field number");
  }
  if (wireType === 6 || wireType === 7) {
    fail("field key has an invalid wire type");
  }

  return {
    end: key.end,
    fieldNumber: Number(fieldNumber),
    wireType,
  };
};

const requireBytes = (
  body: Uint8Array,
  start: number,
  count: number,
  label: string
): number => {
  const end = start + count;
  if (end > body.byteLength) {
    fail(`${label} is truncated`);
  }
  return end;
};

const skipField = (
  body: Uint8Array,
  start: number,
  fieldNumber: number,
  wireType: number,
  depth: number
): number => {
  if (wireType === 0) {
    return readCanonicalVarint(body, start, UINT64_MAX, "varint field").end;
  }
  if (wireType === 1) {
    return requireBytes(body, start, 8, "fixed64 field");
  }
  if (wireType === 2) {
    const length = readCanonicalVarint(
      body,
      start,
      UINT32_MAX,
      "length-delimited field length"
    );
    const remaining = BigInt(body.byteLength - length.end);
    if (length.value > remaining) {
      fail("length-delimited field is truncated");
    }
    return length.end + Number(length.value);
  }
  if (wireType === 3) {
    if (depth >= MAX_GROUP_DEPTH) {
      fail("group nesting is too deep");
    }
    let cursor = start;
    while (cursor < body.byteLength) {
      const key = readFieldKey(body, cursor);
      cursor = key.end;
      if (key.wireType === 4) {
        if (key.fieldNumber !== fieldNumber) {
          fail("group has a mismatched end tag");
        }
        return cursor;
      }
      cursor = skipField(
        body,
        cursor,
        key.fieldNumber,
        key.wireType,
        depth + 1
      );
    }
    return fail("group field is truncated");
  }
  if (wireType === 4) {
    return fail("message has an unexpected end-group tag");
  }
  if (wireType === 5) {
    return requireBytes(body, start, 4, "fixed32 field");
  }
  return fail("field has an invalid wire type");
};

const findSequenceField = (body: Uint8Array): SequenceField => {
  let cursor = 0;
  let sequence: SequenceField | undefined;

  while (cursor < body.byteLength) {
    const key = readFieldKey(body, cursor);
    cursor = key.end;

    if (key.fieldNumber !== 1) {
      cursor = skipField(body, cursor, key.fieldNumber, key.wireType, 0);
      continue;
    }
    if (key.wireType !== 0) {
      fail("field 1 must use the varint wire type");
    }
    if (sequence !== undefined) {
      fail("field 1 appears more than once");
    }

    const valueStart = cursor;
    const parsed = readCanonicalVarint(
      body,
      valueStart,
      SIGNED_INT64_MAX,
      "field 1 varint"
    );
    sequence = {
      value: parsed.value,
      valueEnd: parsed.end,
      valueStart,
    };
    cursor = parsed.end;
  }

  return sequence ?? fail("field 1 is missing");
};

const encodeCanonicalVarint = (value: bigint): Uint8Array => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const payload = Number(remaining % 128n);
    remaining /= 128n;
    bytes.push(remaining === 0n ? payload : payload + 128);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
};

const decoderSafeBody = (
  body: Uint8Array,
  sequence: SequenceField
): Uint8Array => {
  if (sequence.value <= SAFE_DECODER_SEQUENCE) {
    return Uint8Array.from(body);
  }

  const safeValue = encodeCanonicalVarint(SAFE_DECODER_SEQUENCE);
  const replacedLength = sequence.valueEnd - sequence.valueStart;
  const result = new Uint8Array(
    body.byteLength - replacedLength + safeValue.byteLength
  );
  result.set(body.subarray(0, sequence.valueStart));
  result.set(safeValue, sequence.valueStart);
  result.set(
    body.subarray(sequence.valueEnd),
    sequence.valueStart + safeValue.byteLength
  );
  return result;
};

/**
 * Reads the exact top-level CatchUpEventsResponse sequence without narrowing
 * it through JavaScript's number type. The returned decoder body is always an
 * independent copy. Above Number.MAX_SAFE_INTEGER, only field 1's value bytes
 * are replaced so the legacy decoder cannot silently round the source cursor.
 */
export const inspectCatchUpSequence = (
  body: Uint8Array
): CatchUpSequenceInspection => {
  const field = findSequenceField(body);
  return {
    decoderBody: decoderSafeBody(body, field),
    sequence: field.value,
    sequenceDecimal: field.value.toString(10),
  };
};
