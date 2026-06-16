import type { FusorVerify, FusorVerifyRequest } from "../../fusor/types";
import type { DiscordConfig } from "./config";
import type { DiscordPayload, GatewayDispatch } from "./types";

/**
 * isDispatch ensures that the provided payload data has
 * the required `t` property as it determines what type of payload data to expect.
 * @param value payload data
 * @returns Whether or not the payload data is a valid Gateway dispatch
 */
const isDispatch = (value: unknown): value is GatewayDispatch =>
  typeof value === "object" &&
  value !== null &&
  "t" in value &&
  typeof (value as { t: unknown }).t === "string";

const parseDispatch = (bodyText: string): GatewayDispatch => {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("Discord event body is not valid JSON");
  }
  if (!isDispatch(json)) {
    throw new Error(
      "Discord event payload is missing a string `t` (event name)"
    );
  }
  return json;
};

/**
 * Build the Fusor `verify` hook. Discord inbound is delivered over the Fusor
 * control plane: Fusor holds the Gateway connection and relays each dispatch
 * frame, so the authenticated transport IS the trust boundary — there is no
 * per-event Discord signature to check.
 * Receiving: decode the relayed body into a Gateway dispatch (`{ t, d }`) and
 * return it as the payload.
 * Throwing rejects the event. The inbound mapper reads `config` from its own
 * ctx and builds a REST client inline only when it needs to fetch attachment bytes.
 */
export const verify =
  (_config: DiscordConfig): FusorVerify<DiscordPayload> =>
  (req: FusorVerifyRequest): DiscordPayload =>
    parseDispatch(new TextDecoder().decode(req.rawBody));
