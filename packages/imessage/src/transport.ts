import {
  createGrpcClient,
  type AdvancedIMessage as StreamingClient,
} from "@photon-ai/advanced-imessage/grpc";
import {
  type ClientOptions,
  createHttpClient,
  type AdvancedIMessage as UnaryClient,
} from "@photon-ai/advanced-imessage/http";
import { UnsupportedError } from "@spectrum-ts/core";

export type IMessageTransport = "grpc" | "http";

export const DEFAULT_IMESSAGE_TRANSPORT: IMessageTransport = "grpc";

export type IMessageStreamingClient = StreamingClient;

export type IMessageTransportHandle =
  | { client: StreamingClient; transport?: "grpc" }
  | { client: UnaryClient; transport: "http" };

const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;
const LOCAL_HOSTNAMES = new Set(["localhost", "[::1]"]);

const rejectPlaintextAddress = (address: string): void => {
  if (!address.toLowerCase().startsWith("http://")) {
    return;
  }
  const { hostname } = new URL(address);
  if (LOCAL_HOSTNAMES.has(hostname) || LOOPBACK_IPV4.test(hostname)) {
    return;
  }
  throw new Error(
    `The iMessage HTTP transport will not send credentials over plaintext http:// to ${hostname}. Use https://.`
  );
};

export const createHandle = (
  transport: IMessageTransport,
  options: ClientOptions
): IMessageTransportHandle => {
  const defaults = { autoIdempotency: true, retry: true, tls: true } as const;
  if (transport === "http") {
    rejectPlaintextAddress(options.address);
    return { client: createHttpClient({ ...defaults, ...options }), transport };
  }
  return { client: createGrpcClient({ ...defaults, ...options }), transport };
};

export const requireStreamingClient = (
  handle: IMessageTransportHandle
): IMessageStreamingClient => {
  if (handle.transport === "http") {
    throw UnsupportedError.action(
      "message stream",
      "imessage",
      "The HTTP transport carries no event streams. Receive inbound messages over webhooks, or configure the gRPC transport to use the live stream."
    );
  }
  return handle.client;
};
