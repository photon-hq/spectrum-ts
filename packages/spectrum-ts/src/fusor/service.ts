// biome-ignore-all lint/suspicious/noBitwiseOperators: protobuf wire-format tag encoding/decoding requires bitwise ops
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import {
  InboundReply,
  RawInboundEvent,
} from "@photon-ai/proto/photon/fusor/v1/inbound";

/**
 * SDK-side bindings for `photon.fusor.internal.v1.EventsService.Subscribe`.
 *
 * Only the `RawInboundEvent` and `InboundReply` message types come from the
 * public `@photon-ai/proto` package — the bidi envelope messages
 * (`SubscribeInit`, `SubscribeRequest`, `SubscribeResponse`) are hand-rolled
 * against the same `@bufbuild/protobuf/wire` `BinaryWriter`/`BinaryReader`
 * the proto package uses, so we don't have to depend on internal protos.
 */

export interface SubscribeInit {
  startSeq: number;
}

export interface SubscribeRequest {
  init?: SubscribeInit | undefined;
  reply?: InboundReply | undefined;
}

export interface SubscribeResponse {
  event: RawInboundEvent | undefined;
  replyInbox: string;
  seq: number;
}

const SubscribeInitFns = {
  encode(message: SubscribeInit, writer: BinaryWriter = new BinaryWriter()) {
    if (message.startSeq !== 0) {
      writer.uint32(8).uint64(message.startSeq);
    }
    return writer;
  },
  decode(input: BinaryReader | Uint8Array, length?: number): SubscribeInit {
    const reader =
      input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message: SubscribeInit = { startSeq: 0 };
    while (reader.pos < end) {
      const tag = reader.uint32();
      if (tag >>> 3 === 1 && tag === 8) {
        message.startSeq = Number(reader.uint64());
        continue;
      }
      reader.skip(tag & 7);
    }
    return message;
  },
};

export const SubscribeRequestFns = {
  encode(message: SubscribeRequest, writer: BinaryWriter = new BinaryWriter()) {
    if (message.init !== undefined) {
      SubscribeInitFns.encode(message.init, writer.uint32(10).fork()).join();
    }
    if (message.reply !== undefined) {
      InboundReply.encode(message.reply, writer.uint32(18).fork()).join();
    }
    return writer;
  },
  decode(input: BinaryReader | Uint8Array, length?: number): SubscribeRequest {
    const reader =
      input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message: SubscribeRequest = {};
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            reader.skip(tag & 7);
            break;
          }
          message.init = SubscribeInitFns.decode(reader, reader.uint32());
          break;
        }
        case 2: {
          if (tag !== 18) {
            reader.skip(tag & 7);
            break;
          }
          message.reply = InboundReply.decode(reader, reader.uint32());
          break;
        }
        default:
          reader.skip(tag & 7);
      }
    }
    return message;
  },
  fromPartial(value: SubscribeRequest): SubscribeRequest {
    return value;
  },
};

export const SubscribeResponseFns = {
  encode(
    message: SubscribeResponse,
    writer: BinaryWriter = new BinaryWriter()
  ) {
    if (message.seq !== 0) {
      writer.uint32(8).uint64(message.seq);
    }
    if (message.event !== undefined) {
      RawInboundEvent.encode(message.event, writer.uint32(18).fork()).join();
    }
    if (message.replyInbox !== "") {
      writer.uint32(26).string(message.replyInbox);
    }
    return writer;
  },
  decode(input: BinaryReader | Uint8Array, length?: number): SubscribeResponse {
    const reader =
      input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message: SubscribeResponse = {
      seq: 0,
      event: undefined,
      replyInbox: "",
    };
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 8) {
            reader.skip(tag & 7);
            break;
          }
          message.seq = Number(reader.uint64());
          break;
        }
        case 2: {
          if (tag !== 18) {
            reader.skip(tag & 7);
            break;
          }
          message.event = RawInboundEvent.decode(reader, reader.uint32());
          break;
        }
        case 3: {
          if (tag !== 26) {
            reader.skip(tag & 7);
            break;
          }
          message.replyInbox = reader.string();
          break;
        }
        default:
          reader.skip(tag & 7);
      }
    }
    return message;
  },
  fromPartial(value: SubscribeResponse): SubscribeResponse {
    return value;
  },
};

/**
 * nice-grpc TsProto-style service definition for the bidi Subscribe RPC.
 * The wrapper-message types are internal to spectrum-ts; the only types
 * that cross the public API are `RawInboundEvent` and `InboundReply`
 * from the public `@photon-ai/proto` package.
 */
export const EventsServiceDefinition = {
  name: "EventsService",
  fullName: "photon.fusor.internal.v1.EventsService",
  methods: {
    subscribe: {
      name: "Subscribe",
      requestType: SubscribeRequestFns,
      requestStream: true as const,
      responseType: SubscribeResponseFns,
      responseStream: true as const,
      options: {},
    },
  },
} as const;
