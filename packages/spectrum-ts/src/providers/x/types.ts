export interface XCrcPayload {
  crcToken: string;
  type: "crc";
}

export interface XDmPayload {
  body: unknown;
  type: "dm";
}

/**
 * Verified inbound payload consumed by the fusor `messages` handler:
 * either a CRC challenge (GET) or a signed DM webhook body (POST).
 */
export type XPayload = XCrcPayload | XDmPayload;
