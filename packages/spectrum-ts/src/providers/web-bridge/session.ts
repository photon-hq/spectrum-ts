import type { ServerResponse } from "node:http";

export type BridgeEvent =
  | { requestId: string; type: "text_start" }
  | { delta: string; requestId: string; type: "text_delta" }
  | { requestId: string; type: "text_end" }
  | { message: string; requestId: string; type: "error" };

interface PendingSessionOptions {
  onClose: (session: PendingBridgeSession) => void;
  requestId: string;
  response: ServerResponse;
  responseSessionId: string;
  timeoutMs: number;
}

/**
 * Owns the HTTP response stream for one web request waiting on Spectrum code.
 *
 * The worker can receive many simultaneous requests for the same logical
 * `spaceId`; matching by this request-specific session id is what prevents a
 * slow reply for request A from being written to request B.
 */
export class PendingBridgeSession {
  readonly requestId: string;
  readonly responseSessionId: string;

  #closed = false;
  readonly #onClose: (session: PendingBridgeSession) => void;
  readonly #response: ServerResponse;
  readonly #timer: ReturnType<typeof setTimeout>;

  constructor(options: PendingSessionOptions) {
    this.requestId = options.requestId;
    this.responseSessionId = options.responseSessionId;
    this.#onClose = options.onClose;
    this.#response = options.response;
    this.#timer = setTimeout(() => {
      this.fail("timeout");
    }, options.timeoutMs);
    this.#timer.unref?.();

    this.#response.on("close", () => {
      this.close();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#onClose(this);
    if (!(this.#response.destroyed || this.#response.writableEnded)) {
      this.#response.end();
    }
  }

  fail(message: string): void {
    if (this.#closed) {
      return;
    }
    this.write({ type: "error", requestId: this.requestId, message });
    this.close();
  }

  writeText(text: string): boolean {
    if (this.#closed) {
      return false;
    }
    this.write({ type: "text_start", requestId: this.requestId });
    this.write({ type: "text_delta", requestId: this.requestId, delta: text });
    this.write({ type: "text_end", requestId: this.requestId });
    this.close();
    return true;
  }

  private write(event: BridgeEvent): void {
    this.#response.write(`${JSON.stringify(event)}\n`);
  }
}

export function writeNdjsonHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "application/x-ndjson; charset=utf-8",
  });
}
