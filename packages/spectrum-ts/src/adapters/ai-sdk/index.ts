import {
  type ChatTransport,
  DefaultChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

type HeaderFactory =
  | Headers
  | Record<string, string>
  | (() => Headers | Promise<Headers>)
  | (() => Promise<Record<string, string>> | Record<string, string>);

export interface SpectrumChatTransportOptions<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends Omit<
    HttpChatTransportInitOptions<UI_MESSAGE>,
    "api" | "headers" | "prepareSendMessagesRequest"
  > {
  agentId?: string;
  conversationId?: string;
  endpoint: string;
  headers?: HeaderFactory;
  idempotencyKey?: (options: {
    requestId: string;
    submittedMessageId: string;
  }) => string;
  metadata?: Record<string, unknown>;
}

// AI SDK supplies `messageId` for regeneration but not for normal submits, so
// submit requests intentionally fall back to the latest user message id.
function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req_${Date.now()}`;
}

function latestUserMessageId(messages: UIMessage[]): string | undefined {
  for (const message of messages.toReversed()) {
    if (message.role === "user") {
      return message.id;
    }
  }
}

async function resolveHeaders(
  headers: HeaderFactory
): Promise<Headers | Record<string, string>> {
  return typeof headers === "function" ? await headers() : headers;
}

/**
 * Browser-safe AI SDK transport that points `useChat` at Spectrum's `webChat`
 * provider endpoint instead of an app-owned `/api/chat` route.
 *
 * The transport preserves AI SDK's stream parsing by delegating to
 * `DefaultChatTransport`, but replaces the request body with a Spectrum
 * envelope that explicitly identifies the submitted turn and idempotency key.
 */
export class SpectrumChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  readonly #transport: DefaultChatTransport<UI_MESSAGE>;

  constructor(options: SpectrumChatTransportOptions<UI_MESSAGE>) {
    const {
      agentId,
      conversationId,
      endpoint,
      headers,
      idempotencyKey,
      metadata,
      ...transportOptions
    } = options;

    const init: HttpChatTransportInitOptions<UI_MESSAGE> = {
      ...transportOptions,
      api: endpoint,
      prepareSendMessagesRequest: async (request) => {
        const requestId = createRequestId();
        const submittedMessageId =
          request.messageId ?? latestUserMessageId(request.messages);
        if (!submittedMessageId) {
          throw new Error(
            "SpectrumChatTransport: unable to resolve submittedMessageId."
          );
        }
        const idempotencyKeyValue =
          idempotencyKey?.({
            requestId,
            submittedMessageId,
          }) ?? submittedMessageId;

        return {
          api: request.api,
          body: {
            ...request.body,
            agentId,
            conversationId,
            id: request.id,
            idempotencyKey: idempotencyKeyValue,
            messages: request.messages,
            metadata,
            requestId,
            submittedMessageId,
            trigger: request.trigger,
          },
          credentials: request.credentials,
          headers: request.headers,
        };
      },
    };

    if (headers) {
      init.headers = async () => await resolveHeaders(headers);
    }

    this.#transport = new DefaultChatTransport<UI_MESSAGE>(init);
  }

  sendMessages(
    options: Parameters<ChatTransport<UI_MESSAGE>["sendMessages"]>[0]
  ): Promise<ReadableStream<UIMessageChunk>> {
    return this.#transport.sendMessages(options);
  }

  reconnectToStream(
    options: Parameters<ChatTransport<UI_MESSAGE>["reconnectToStream"]>[0]
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return this.#transport.reconnectToStream(options);
  }
}
