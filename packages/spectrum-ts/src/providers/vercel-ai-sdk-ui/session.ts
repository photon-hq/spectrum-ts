import type { VercelAiSdkUIConfig } from "./config";

// A pending session owns one open AI SDK UI response. Spectrum replies arrive
// later through provider send(...), so this object buffers early text until the
// AI SDK stream writer is attached.
export type TextStreamPart =
  | { id: string; type: "text-start" }
  | { delta: string; id: string; type: "text-delta" }
  | { id: string; type: "text-end" };

export interface StreamWriter {
  write(part: TextStreamPart): void;
}

interface SessionRegistry {
  pendingBySpaceId: Map<string, PendingResponseSession[]>;
}

interface PendingResponseSessionOptions {
  closeOnFirstTextSend: boolean;
  onClose: (session: PendingResponseSession) => void;
  signal: AbortSignal;
  spaceId: string;
  timeoutMs: number;
}

export class PendingResponseSession {
  readonly done: Promise<void>;
  readonly id = crypto.randomUUID();
  readonly spaceId: string;

  readonly #closeOnFirstTextSend: boolean;
  #closed = false;
  #closeWhenPendingTextFlushes = false;
  readonly #onClose: (session: PendingResponseSession) => void;
  readonly #pendingText: string[] = [];
  readonly #removeAbortListener: () => void;
  #resolveDone: () => void = () => undefined;
  #textPartIndex = 0;
  readonly #timer: ReturnType<typeof setTimeout>;
  #writer: StreamWriter | undefined;

  constructor(options: PendingResponseSessionOptions) {
    this.spaceId = options.spaceId;
    this.#closeOnFirstTextSend = options.closeOnFirstTextSend;
    this.#onClose = options.onClose;
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
    const abort = () => this.close();
    options.signal.addEventListener("abort", abort, { once: true });
    this.#removeAbortListener = () => {
      options.signal.removeEventListener("abort", abort);
    };
    this.#timer = setTimeout(() => {
      this.close();
    }, options.timeoutMs);
    this.#timer.unref?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  attach(writer: StreamWriter): void {
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

  writeText(text: string): boolean {
    if (this.#closed) {
      return false;
    }
    const wrote = this.writeTextPart(text);
    if (wrote && this.#closeOnFirstTextSend) {
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
    // An agent can reply synchronously while createUIMessageStream is still
    // attaching its writer; flush preserves that response instead of dropping
    // a valid Spectrum send.
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
    const textPartId = `${this.id}-text-${this.#textPartIndex}`;
    // AI SDK v6 requires one stable text part id across start/delta/end.
    this.#writer?.write({ type: "text-start", id: textPartId });
    this.#writer?.write({
      type: "text-delta",
      id: textPartId,
      delta: text,
    });
    this.#writer?.write({ type: "text-end", id: textPartId });
  }
}

function removeSession(
  registry: SessionRegistry,
  session: PendingResponseSession
): void {
  const sessions = registry.pendingBySpaceId.get(session.spaceId);
  if (!sessions) {
    return;
  }
  const remaining = sessions.filter((item) => item !== session);
  if (remaining.length === 0) {
    registry.pendingBySpaceId.delete(session.spaceId);
    return;
  }
  registry.pendingBySpaceId.set(session.spaceId, remaining);
}

export function addSession(
  registry: SessionRegistry,
  config: VercelAiSdkUIConfig,
  spaceId: string,
  signal: AbortSignal
): PendingResponseSession {
  const session = new PendingResponseSession({
    closeOnFirstTextSend: config.closeOnFirstTextSend,
    onClose: (closedSession) => removeSession(registry, closedSession),
    signal,
    spaceId,
    timeoutMs: config.responseTimeoutMs,
  });
  const existing = registry.pendingBySpaceId.get(spaceId) ?? [];
  existing.push(session);
  registry.pendingBySpaceId.set(spaceId, existing);
  if (signal.aborted) {
    session.close();
  }
  return session;
}

export function oldestOpenSession(
  registry: SessionRegistry,
  spaceId: string
): PendingResponseSession | undefined {
  const sessions = registry.pendingBySpaceId.get(spaceId);
  if (!sessions) {
    return;
  }
  const openSessions = sessions.filter((session) => !session.closed);
  if (openSessions.length === 0) {
    registry.pendingBySpaceId.delete(spaceId);
    return;
  }
  if (openSessions.length !== sessions.length) {
    registry.pendingBySpaceId.set(spaceId, openSessions);
  }
  // Intentionally uses FIFO matching per space. This keeps the provider
  // additive, but concurrent same-space requests can still cross-wire replies.
  return openSessions[0];
}
