import { createHmac } from "node:crypto";

export interface CrcResponse {
  response_token: string;
}

/**
 * Build the CRC challenge response X expects during webhook registration
 * (`response_token` = `sha256=` + base64 HMAC of the token). This is ran
 * locally to answer the CRC challenge.
 * @param crcToken - The CRC token received from X.
 * @param consumerSecret - The consumer secret of the project. This is used to sign the response.
 * @returns The CRC response. This is the response that X expects during webhook registration.
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
