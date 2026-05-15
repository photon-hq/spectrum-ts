import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

export type WebChatStreamPart =
  | { id: string; type: "text-start" }
  | { delta: string; id: string; type: "text-delta" }
  | { id: string; type: "text-end" };

export interface WebChatStreamWriter {
  write(part: WebChatStreamPart): void;
}

export interface WebChatSessionOptions {
  onClose: (session: WebChatSession) => void;
  requestId: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * Owns one request-scoped AI SDK UI response stream.
 *
 * Spectrum replies arrive through provider `send(...)` after the HTTP handler
 * has returned a `Response`. This object keeps the stream open, buffers early
 * text until AI SDK attaches the writer, and closes the exact request when its
 * reply, abort signal, or timeout completes.
 */
export class WebChatSession {
  readonly done: Promise<void>;
  readonly requestId: string;

  #closed = false;
  #closeWhenPendingTextFlushes = false;
  readonly #onClose: (session: WebChatSession) => void;
  readonly #pendingText: string[] = [];
  readonly #removeAbortListener: () => void;
  #resolveDone: () => void = () => undefined;
  #textPartIndex = 0;
  readonly #timer: ReturnType<typeof setTimeout>;
  #writer: WebChatStreamWriter | undefined;

  constructor(options: WebChatSessionOptions) {
    this.requestId = options.requestId;
    this.#onClose = options.onClose;
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });

    const abort = () => this.close();
    options.signal.addEventListener("abort", abort, { once: true });
    this.#removeAbortListener = () => {
      options.signal.removeEventListener("abort", abort);
    };
    this.#timer = setTimeout(() => this.close(), options.timeoutMs);
    this.#timer.unref?.();

    if (options.signal.aborted) {
      this.close();
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  attach(writer: WebChatStreamWriter): void {
    if (this.#closed) {
      return;
    }
    this.#writer = writer;
    this.flushPendingText();
    if (this.#closeWhenPendingTextFlushes) {
      this.close();
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#removeAbortListener();
    this.#onClose(this);
    this.#resolveDone();
  }

  response(): Response {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        this.attach(writer);
        return this.done;
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  writeText(text: string): boolean {
    if (this.#closed) {
      return false;
    }

    const wrote = this.writeTextPart(text);
    if (wrote) {
      if (this.#writer) {
        this.close();
      } else {
        this.#closeWhenPendingTextFlushes = true;
      }
    }
    return wrote;
  }

  private flushPendingText(): void {
    if (!this.#writer) {
      return;
    }

    while (this.#pendingText.length > 0) {
      const text = this.#pendingText.shift();
      if (text !== undefined) {
        this.writeTextChunk(text);
      }
    }
  }

  private writeTextPart(text: string): boolean {
    if (this.#closed) {
      return false;
    }
    if (!this.#writer) {
      this.#pendingText.push(text);
      return true;
    }
    this.writeTextChunk(text);
    return true;
  }

  private writeTextChunk(text: string): void {
    this.#textPartIndex += 1;
    const id = `${this.requestId}-text-${this.#textPartIndex}`;
    this.#writer?.write({ type: "text-start", id });
    this.#writer?.write({ type: "text-delta", id, delta: text });
    this.#writer?.write({ type: "text-end", id });
  }
}
