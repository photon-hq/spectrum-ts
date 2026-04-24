// JSON-RPC 2.0 over TCP with LSP-style Content-Length framing.
// Speaks the protocol documented at https://github.com/photon-hq/tuichat/blob/main/PROTOCOL.md.
//
// Inlined into this provider rather than imported from an external package so
// spectrum-ts takes no new runtime dependencies.

import type { Socket } from "node:net";

export const PROTOCOL_VERSION = "1" as const;

export type ProtocolContent =
  | { type: "text"; text: string }
  | {
      type: "attachment";
      name: string;
      mimeType: string;
      size?: number;
      bytes?: string;
      path?: string;
    }
  | {
      type: "voice";
      name?: string;
      mimeType: string;
      size?: number;
      bytes?: string;
      path?: string;
    }
  | {
      type: "contact";
      name?: {
        formatted?: string;
        first?: string;
        last?: string;
      };
      vcard?: string;
    }
  | { type: "custom"; raw: unknown };

export interface ProtocolMessageNotification {
  content: ProtocolContent;
  id: string;
  replyTo?: { messageId: string };
  senderId: string;
  spaceId: string;
  timestamp: string;
}

export interface ProtocolReactionNotification {
  messageId: string;
  reaction: string;
  senderId: string;
  spaceId: string;
  timestamp: string;
}

interface RpcRequest {
  id: number | string;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface RpcResponse {
  error?: { code: number; message: string };
  id: number | string;
  jsonrpc: "2.0";
  result?: unknown;
}

type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

// ----- codec -----

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH = "content-length:";

function encode(message: RpcMessage): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

class Decoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RpcMessage[] {
    this.buf =
      this.buf.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buf, chunk]);
    const out: RpcMessage[] = [];
    for (;;) {
      const msg = this.readOne();
      if (!msg) {
        break;
      }
      out.push(msg);
    }
    return out;
  }

  private readOne(): RpcMessage | null {
    const end = this.buf.indexOf(HEADER_TERMINATOR);
    if (end < 0) {
      return null;
    }
    const header = this.buf.subarray(0, end).toString("utf8");
    let len = -1;
    for (const line of header.split("\r\n")) {
      if (line.toLowerCase().startsWith(CONTENT_LENGTH)) {
        const n = Number.parseInt(line.slice(CONTENT_LENGTH.length).trim(), 10);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error("invalid Content-Length");
        }
        len = n;
      }
    }
    if (len < 0) {
      throw new Error("missing Content-Length header");
    }
    const bodyStart = end + HEADER_TERMINATOR.length;
    const bodyEnd = bodyStart + len;
    if (this.buf.length < bodyEnd) {
      return null;
    }
    const body = this.buf.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buf = this.buf.subarray(bodyEnd);
    return JSON.parse(body) as RpcMessage;
  }
}

// ----- session -----

export class RpcSession {
  private readonly decoder = new Decoder();
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private onNotify: ((method: string, params: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;
  private closed = false;
  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handle(chunk));
    socket.on("close", () => this.shutdown());
    socket.on("error", () => this.shutdown());
  }

  handleNotifications(h: (method: string, params: unknown) => void): void {
    this.onNotify = h;
  }
  onClosed(h: () => void): void {
    this.onClose = h;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    if (this.closed) {
      throw new Error("session closed");
    }
    const id = this.nextId++;
    const msg: RpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
      };
      this.pending.set(id, {
        resolve: (v) => {
          if (settled) {
            return;
          }
          done();
          resolve(v as T);
        },
        reject: (e) => {
          if (settled) {
            return;
          }
          done();
          reject(e);
        },
      });
      if (timeoutMs !== undefined && timeoutMs >= 0) {
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          this.pending.delete(id);
          reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // Don't pin the Node event loop open just because an RPC timeout is
        // scheduled — if the agent wants to exit before the timeout fires,
        // let it. The settled guard above handles the unref'd-tick-after-
        // exit case cleanly.
        timer.unref?.();
      }
      try {
        this.socket.write(encode(msg));
      } catch (err) {
        if (settled) {
          return;
        }
        done();
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    const msg: RpcNotification = { jsonrpc: "2.0", method, params };
    try {
      this.socket.write(encode(msg));
    } catch {
      // best-effort — drops are fine for notifications (log spam shouldn't
      // crash the agent if the socket is transiently unavailable).
    }
  }

  close(): void {
    this.shutdown();
  }

  private handle(chunk: Buffer): void {
    let msgs: RpcMessage[];
    try {
      msgs = this.decoder.push(chunk);
    } catch {
      this.shutdown();
      return;
    }
    for (const m of msgs) {
      if ("id" in m && "method" in m) {
        // Server→client requests aren't part of our protocol; ignore.
        continue;
      }
      if ("id" in m) {
        const p = this.pending.get(m.id);
        if (!p) {
          continue;
        }
        this.pending.delete(m.id);
        if (m.error) {
          p.reject(new Error(m.error.message));
        } else {
          p.resolve(m.result);
        }
      } else if ("method" in m) {
        try {
          this.onNotify?.(m.method, m.params);
        } catch {
          // notifications have no response
        }
      }
    }
  }

  private shutdown(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const p of this.pending.values()) {
      p.reject(new Error("session closed"));
    }
    this.pending.clear();
    try {
      this.socket.end();
    } catch {
      // best-effort
    }
    try {
      this.socket.destroy();
    } catch {
      // best-effort
    }
    this.onClose?.();
  }
}
