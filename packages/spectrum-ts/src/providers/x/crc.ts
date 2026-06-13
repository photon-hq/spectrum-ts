import { createHmac } from "node:crypto";

export interface CrcResponse {
  response_token: string;
}

/**
 * Build the CRC challenge response X expects during webhook registration
 * (`response_token` = `sha256=` + base64 HMAC of the token).
 */
export const createCrcResponse = (
  crcToken: string,
  consumerSecret: string
): CrcResponse => {
  const digest = createHmac("sha256", consumerSecret)
    .update(crcToken)
    .digest("base64");
  return { response_token: `sha256=${digest}` };
};
