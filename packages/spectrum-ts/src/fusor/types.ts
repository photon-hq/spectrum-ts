import type { ProviderMessageRecord } from "../platform/types";

export interface FusorVerifyRequest {
  headers: Record<string, string>;
  method: string;
  path: string;
  rawBody: Uint8Array;
}

export type FusorVerify<TPayload = unknown> = (
  req: FusorVerifyRequest
) => TPayload | Promise<TPayload>;

export interface FusorReply {
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  status?: number;
}

export type FusorRespond = (reply: FusorReply) => void;

export interface FusorMessagesCtx<TPayload> {
  payload: TPayload;
  respond: FusorRespond;
}

export type FusorMessagesReturn =
  | ProviderMessageRecord
  | ProviderMessageRecord[]
  | undefined;

export type FusorMessages<TPayload> = (
  ctx: FusorMessagesCtx<TPayload>
) => FusorMessagesReturn | Promise<FusorMessagesReturn>;

export const FUSOR_BRAND: unique symbol = Symbol.for("spectrum.fusor.client");

export interface FusorClient<TPayload = unknown> {
  readonly platform: string;
  readonly verify: FusorVerify<TPayload>;
  readonly [FUSOR_BRAND]: true;
}
