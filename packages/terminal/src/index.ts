// The `terminal` Spectrum provider. On every createClient, spawns the
// standalone tuichat binary (auto-downloaded from GitHub Releases on first
// use) and drives it via JSON-RPC. The binary itself chooses between its
// rich TUI and a non-TTY readline fallback, so this adapter is symmetric
// and language-portable — any other SDK's adapter just has to spawn +
// speak the protocol.
//
// Protocol: https://github.com/photon-hq/tuichat/blob/main/PROTOCOL.md

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { inspect } from "node:util";
import {
  type Content,
  definePlatform,
  fromVCard,
  type ManagedStream,
  // Aliased: `stream` is already used as a local name inside protocolToSpectrum.
  stream as managedStream,
  toVCard,
  UnsupportedError,
} from "@spectrum-ts/core";
import {
  asAttachment,
  asContact,
  asCustom,
  asVoice,
  type ProviderMessageRecord,
  reactionSchema,
} from "@spectrum-ts/core/authoring";
import z from "zod";
import {
  type ProtocolContent,
  type ProtocolMessageNotification,
  type ProtocolReactionNotification,
  RpcSession,
} from "./protocol";
import { resolveTuichatBinary } from "./resolve-binary";

// Grace period for the shutdown RPC at teardown. Beyond this we stop waiting
// and tear the session/subprocess down unilaterally so destroyClient always
// completes in a bounded time.
const SHUTDOWN_TIMEOUT_MS = 2000;
const SPAWN_CONNECT_TIMEOUT_MS = 10_000;
// Upper bound on `initialize` — the subprocess has connected but if the
// protocol handshake gets stuck, we'd rather fail fast than hang
// createClient indefinitely.
const INITIALIZE_TIMEOUT_MS = 10_000;

const commandSchema = z.object({
  name: z.string().regex(/^\/[A-Za-z0-9_-]+$/, "command must start with /"),
  description: z.string().optional(),
});

// ----- console hijack -----
// While tuichat owns the terminal (stdio: "inherit"), any direct console.*
// write from agent code would garble the TUI mid-render. We monkeypatch
// console to forward each call as a `log` notification, which the binary
// renders into a pinned __system__ chat. Restored on destroyClient.

const LOG_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleHijack {
  restore: () => void;
}

function installConsoleHijack(session: RpcSession): ConsoleHijack {
  const originals: Record<LogLevel, ConsoleMethod> = {} as Record<
    LogLevel,
    ConsoleMethod
  >;
  // Re-entrancy guard: if some downstream code invokes console during our
  // forwarding path, fall back to the original to avoid infinite loops.
  let forwarding = false;
  for (const level of LOG_LEVELS) {
    originals[level] = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (forwarding) {
        originals[level](...args);
        return;
      }
      forwarding = true;
      try {
        const text = args
          .map((a) =>
            typeof a === "string" ? a : inspect(a, { depth: 3, colors: false })
          )
          .join(" ");
        session.notify("log", { level, text });
      } finally {
        forwarding = false;
      }
    };
  }
  return {
    restore: () => {
      for (const level of LOG_LEVELS) {
        console[level] = originals[level];
      }
    },
  };
}

// InboundEvent is a user-originated event surfaced to the agent. Messages
// (including replies) arrive with their original shape; reactions are
// normalized to a `custom`-content message so the agent's single `messages`
// iterator sees everything — matching the WhatsApp provider's convention of
// routing non-message events through `custom` content.
type InboundEvent =
  | { kind: "message"; value: ProtocolMessageNotification }
  | { kind: "reaction"; value: ProtocolReactionNotification };

interface TerminalClient {
  events: AsyncIterable<InboundEvent>;
  hijack: ConsoleHijack;
  // Per-client chat tracking — previously module-level globals, which leaked
  // state across provider instances and grew unbounded. Scoped here so each
  // createClient/destroyClient cycle starts fresh.
  knownChats: Set<string>;
  nextChatIndex: number;
  proc: ChildProcess;
  session: RpcSession;
}

function generateChatId(client: TerminalClient): string {
  while (client.knownChats.has(`chat-${client.nextChatIndex}`)) {
    client.nextChatIndex += 1;
  }
  const id = `chat-${client.nextChatIndex}`;
  client.nextChatIndex += 1;
  client.knownChats.add(id);
  return id;
}

function makeEventQueue(): {
  iter: AsyncIterable<InboundEvent>;
  push: (v: InboundEvent) => void;
  close: () => void;
} {
  const queue: InboundEvent[] = [];
  const waiters: Array<(v: IteratorResult<InboundEvent>) => void> = [];
  let closed = false;
  const drain = () => {
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined, done: true });
    }
  };
  const iter: AsyncIterable<InboundEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<InboundEvent>> {
          if (closed && queue.length === 0) {
            return Promise.resolve({ value: undefined, done: true });
          }
          const buffered = queue.shift();
          if (buffered !== undefined) {
            return Promise.resolve({ value: buffered, done: false });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        // return() fires when the consumer's for-await-of loop breaks or
        // when Spectrum.stop() calls iterator.return() upstream. Without
        // this, a pending next() would hang forever because no further
        // push/close is coming. Close + drain so shutdown is always prompt.
        return(): Promise<IteratorResult<InboundEvent>> {
          closed = true;
          drain();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return {
    iter,
    push(v: InboundEvent) {
      if (closed) {
        return;
      }
      const w = waiters.shift();
      if (w) {
        w({ value: v, done: false });
      } else {
        queue.push(v);
      }
    },
    close() {
      closed = true;
      drain();
    },
  };
}

async function spawnClient(options: {
  commands?: { name: string; description?: string }[];
}): Promise<TerminalClient> {
  const binary = await resolveTuichatBinary();

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("tuichat: failed to bind adapter listener");
  }
  const host = "127.0.0.1";
  const port = addr.port;

  const proc = spawn(binary, ["--connect", `${host}:${port}`], {
    stdio: "inherit",
  });
  // Unref so the subprocess doesn't pin the parent event loop once all
  // protocol work is done — the agent can exit cleanly and the OS cleans
  // the child up via the socket close.
  proc.unref();
  proc.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[tuichat] subprocess exited with code ${code}\n`);
    }
  });

  // Wait for the subprocess to dial back. Guard against three failure modes:
  // the spawn itself errors, the subprocess exits before connecting, or it
  // hangs past the connect timeout. In all three we reject immediately,
  // clean up the listener, and SIGTERM any straggling child so no subprocess
  // is orphaned.
  const socket = await new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      server.off("connection", onConnect);
      server.off("error", onServerError);
      proc.off("error", onProcError);
      proc.off("exit", onProcExit);
    };
    const fail = (err: Error, killProc: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      server.close();
      if (killProc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          // best-effort
        }
      }
      reject(err);
    };
    const succeed = (sock: Socket) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      server.close();
      resolve(sock);
    };
    const onConnect = (sock: Socket) => succeed(sock);
    const onServerError = (err: Error) => fail(err, true);
    const onProcError = (err: Error) => fail(err, false);
    const onProcExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(
        new Error(
          `tuichat: subprocess exited before connecting (code=${code ?? "null"}, signal=${signal ?? "null"})`
        ),
        false
      );
    const timer = setTimeout(() => {
      fail(
        new Error(
          `tuichat: subprocess did not connect within ${SPAWN_CONNECT_TIMEOUT_MS}ms`
        ),
        true
      );
    }, SPAWN_CONNECT_TIMEOUT_MS);
    server.once("connection", onConnect);
    server.once("error", onServerError);
    proc.once("error", onProcError);
    proc.once("exit", onProcExit);
  });
  const session = new RpcSession(socket);

  const eventsQ = makeEventQueue();

  session.handleNotifications((method, params) => {
    if (method === "streamEnd") {
      eventsQ.close();
      return;
    }
    if (method === "message") {
      eventsQ.push({
        kind: "message",
        value: params as ProtocolMessageNotification,
      });
      return;
    }
    if (method === "reaction") {
      eventsQ.push({
        kind: "reaction",
        value: params as ProtocolReactionNotification,
      });
      return;
    }
  });
  // hijack is installed only after initialize succeeds (so startup errors
  // reach the real stderr). We hoist the reference here so the onClosed
  // handler below can restore the console if the session dies unexpectedly.
  let hijack: ConsoleHijack | undefined;
  session.onClosed(() => {
    // Restore console the moment the session dies — if the subprocess
    // crashes, subsequent console.* calls would otherwise be swallowed by
    // the hijack forever (session.notify() becomes a no-op on closed).
    // restore() is idempotent, so destroyClient calling it again is fine.
    hijack?.restore();
    eventsQ.close();
  });

  try {
    await session.request(
      "initialize",
      {
        commands: options.commands,
        clientInfo: { name: "spectrum-ts", version: "terminal-provider" },
      },
      INITIALIZE_TIMEOUT_MS
    );
  } catch (err) {
    // initialize didn't complete — tear the session + subprocess down so
    // we don't leak a socket or an orphaned tuichat process. Caller sees
    // a failed createClient with the original error rethrown.
    session.close();
    try {
      proc.kill("SIGTERM");
    } catch {
      // best-effort
    }
    throw err;
  }

  hijack = installConsoleHijack(session);

  return {
    hijack,
    proc,
    session,
    events: eventsQ.iter,
    knownChats: new Set<string>(),
    nextChatIndex: 1,
  };
}

// ----- content conversion (Spectrum Content ↔ ProtocolContent) -----

type SpectrumContent = Content;

// parseTimestamp validates an ISO timestamp string returned by the server —
// an invalid string silently becomes an Invalid Date object through `new
// Date(...)`, which then propagates nonsense through downstream code. We
// fall back to `new Date()` on malformed input so timestamps are always real.
function parseTimestamp(s: string): Date {
  const t = Date.parse(s);
  return Number.isNaN(t) ? new Date() : new Date(t);
}

function buildOutboundRecord(
  result: { id: string; timestamp: string },
  content: SpectrumContent,
  spaceId: string
): ProviderMessageRecord {
  return {
    id: result.id,
    content,
    space: { id: spaceId },
    timestamp: parseTimestamp(result.timestamp),
  };
}

function reactionTargetFromProtocol(
  reaction: ProtocolReactionNotification
): ProviderMessageRecord {
  // The protocol only gives us the target id. Core accepts nested raw provider
  // records in reaction content and wraps them into full Messages before users
  // see the event.
  const target = {
    id: reaction.messageId,
    content: asCustom({ terminal_type: "reaction-target", stub: true }),
    sender: { id: "__unknown__" },
    space: { id: reaction.spaceId },
    timestamp: parseTimestamp(reaction.timestamp),
  } satisfies ProviderMessageRecord;

  return target;
}

function reactionContentFromProtocol(
  reaction: ProtocolReactionNotification
): SpectrumContent {
  return reactionSchema.parse({
    type: "reaction",
    emoji: reaction.reaction,
    target: reactionTargetFromProtocol(reaction),
  });
}

async function spectrumToProtocol(
  content: SpectrumContent
): Promise<ProtocolContent> {
  if (content.type === "text" || content.type === "custom") {
    return content;
  }
  if (content.type === "attachment") {
    const buf = await content.read();
    return {
      type: "attachment",
      name: content.name,
      mimeType: content.mimeType,
      size: content.size,
      bytes: buf.toString("base64"),
    };
  }
  if (content.type === "voice") {
    const buf = await content.read();
    return {
      type: "voice",
      name: content.name,
      mimeType: content.mimeType,
      size: content.size,
      bytes: buf.toString("base64"),
    };
  }
  if (content.type === "contact") {
    // Serialize the full contact to vCard so phones/emails/addresses/org
    // survive the round-trip. The protocol also carries a name hint for
    // peers that prefer not to parse the vCard.
    return {
      type: "contact",
      name: content.name
        ? {
            formatted: content.name.formatted,
            first: content.name.first,
            last: content.name.last,
          }
        : undefined,
      vcard: await toVCard(content),
    };
  }
  // Surface the failure as an UnsupportedError — the platform builder
  // catches those and warns+skips, so an agent sending e.g. `richlink` on
  // this provider gets a warning rather than an uncaught throw that
  // crashes the whole process.
  throw UnsupportedError.content(
    (content as { type: string }).type,
    "Terminal"
  );
}

function protocolToSpectrum(p: ProtocolContent): SpectrumContent {
  if (p.type === "text" || p.type === "custom") {
    return p as SpectrumContent;
  }
  if (p.type === "attachment" || p.type === "voice") {
    const path = p.path;
    const bytesB64 = p.bytes;
    // Lazy factory: creating the rejected promise eagerly triggered Node's
    // unhandled-rejection warnings on consumers that never called read().
    let cached: Promise<Buffer> | undefined;
    const readBytes = (): Promise<Buffer> => {
      if (cached) {
        return cached;
      }
      if (bytesB64) {
        cached = Promise.resolve(Buffer.from(bytesB64, "base64") as Buffer);
      } else if (path) {
        cached = import("node:fs/promises").then((m) => m.readFile(path));
      } else {
        cached = Promise.reject(
          new Error(`${p.type} has neither path nor bytes`)
        );
      }
      return cached;
    };
    const stream = async (): Promise<ReadableStream<Uint8Array>> => {
      if (path) {
        const [{ createReadStream }, { Readable }] = await Promise.all([
          import("node:fs"),
          import("node:stream"),
        ]);
        return Readable.toWeb(
          createReadStream(path)
        ) as ReadableStream<Uint8Array>;
      }
      const buf = await readBytes();
      return new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array(buf));
          ctrl.close();
        },
      });
    };
    if (p.type === "attachment") {
      return asAttachment({
        name: p.name,
        mimeType: p.mimeType,
        size: p.size,
        read: readBytes,
        stream,
      }) as SpectrumContent;
    }
    return asVoice({
      name: p.name,
      mimeType: p.mimeType,
      size: p.size,
      read: readBytes,
      stream,
    }) as SpectrumContent;
  }
  if (p.type === "contact") {
    // Prefer vCard — retains phones/emails/addresses that the `name` hint
    // throws away. Fall back to the name hint if no vCard came through.
    if (p.vcard) {
      try {
        return asContact(fromVCard(p.vcard)) as SpectrumContent;
      } catch {
        // If the vCard is malformed, fall through to the name-only path
        // rather than surfacing an opaque zod error to the agent.
      }
    }
    return asContact({ name: p.name }) as SpectrumContent;
  }
  // Fallback so unknown future shapes don't crash the agent.
  return { type: "custom", raw: p } as SpectrumContent;
}

// ----- the provider -----

// The exact inbound record shape the messages stream emits. Mirrors the
// platform's resolved message type (required sender/space + the `replyTo`
// extra), so the ManagedStream is assignable to the `messages` contract — the
// looser `ProviderMessageRecord` (optional sender/space) is not.
interface TerminalInboundMessage {
  content: SpectrumContent;
  id: string;
  replyTo?: { messageId: string };
  sender: { id: string };
  space: { id: string };
  timestamp: Date;
}

export const terminal = definePlatform("Terminal", {
  config: z.object({
    commands: z.array(commandSchema).optional(),
  }),

  // Declaring a message schema is how extras survive Spectrum's buildMessage
  // filter — without it, unknown fields on the yielded message are stripped.
  message: {
    schema: z.object({
      replyTo: z.object({ messageId: z.string() }).optional(),
    }),
  },

  lifecycle: {
    createClient: async ({ config }) =>
      await spawnClient({ commands: config.commands }),

    destroyClient: async ({ client }) => {
      // Restore console FIRST so any further logs in this teardown go to the
      // real stderr instead of a closing socket.
      client.hijack.restore();
      try {
        // Bounded so an unresponsive subprocess can't hang destroyClient.
        await client.session.request(
          "shutdown",
          undefined,
          SHUTDOWN_TIMEOUT_MS
        );
      } catch {
        // best-effort
      }
      client.session.close();
      try {
        client.proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
    },
  },

  user: {
    resolve: async ({ input }) => ({
      id: input.userID,
    }),
  },

  space: {
    create: async ({ client }) => {
      const id = generateChatId(client);
      client.knownChats.add(id);
      await client.session.request("ensureSpace", { id });
      return { id };
    },
    // Explicit (not the framework default) so targeting a known id still
    // materializes the chat in the TUI via `ensureSpace`.
    get: async ({ client, input }) => {
      client.knownChats.add(input.id);
      await client.session.request("ensureSpace", { id: input.id });
      return { id: input.id };
    },
  },

  // Return a ManagedStream (not a native async generator): a native generator
  // parked on an in-flight `client.events.next()` cannot be force-cancelled —
  // a `.return()` queues behind the pending `next()` and never reaches the
  // event queue, which would deadlock `Spectrum.stop()`. Driving the queue with
  // an explicit pump lets cleanup call the queue iterator's `return()` directly
  // (synchronous close + drain), so the stream tears down promptly on stop()
  // without waiting for destroyClient.
  messages({ client }): ManagedStream<TerminalInboundMessage> {
    return managedStream<TerminalInboundMessage>((emit, end) => {
      const iterator = client.events[Symbol.asyncIterator]();

      const pump = (async () => {
        try {
          let result = await iterator.next();
          while (!result.done) {
            const evt = result.value;
            if (evt.kind === "message") {
              const msg = evt.value;
              client.knownChats.add(msg.spaceId);
              await emit({
                id: msg.id,
                content: protocolToSpectrum(msg.content),
                sender: { id: msg.senderId },
                space: { id: msg.spaceId },
                timestamp: parseTimestamp(msg.timestamp),
                // replyTo is a terminal-specific extra — agents inspect via a
                // cast until Spectrum's message model grows first-class support.
                ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
              });
            } else {
              // Reactions ride the messages stream as first-class `reaction`
              // content. The protocol only provides the target id, so synthesize
              // a minimal raw target for core to wrap into a full Message.
              const r = evt.value;
              client.knownChats.add(r.spaceId);
              await emit({
                id: `reaction:${r.messageId}:${r.reaction}:${r.timestamp}`,
                content: reactionContentFromProtocol(r),
                sender: { id: r.senderId },
                space: { id: r.spaceId },
                timestamp: parseTimestamp(r.timestamp),
              });
            }
            result = await iterator.next();
          }
          end();
        } catch (error) {
          end(error);
        }
      })();

      return async () => {
        await iterator.return?.();
        await pump.catch(() => undefined);
      };
    });
  },

  send: async ({ client, content, space }) => {
    if (content.type === "reply") {
      const inner = await spectrumToProtocol(content.content);
      const result = await client.session.request<{
        id: string;
        timestamp: string;
      }>("replyToMessage", {
        spaceId: space.id,
        messageId: content.target.id,
        content: inner,
      });
      return buildOutboundRecord(result, content.content, space.id);
    }
    if (content.type === "reaction") {
      await client.session.request("reactToMessage", {
        spaceId: space.id,
        messageId: content.target.id,
        reaction: content.emoji,
      });
      // The protocol ack carries no id; synthesize one mirroring the inbound
      // reaction shape.
      const timestamp = new Date();
      return {
        id: `reaction:${content.target.id}:${content.emoji}:${timestamp.toISOString()}`,
        content,
        space: { id: space.id },
        timestamp,
      };
    }
    if (content.type === "typing") {
      // Tuichat exposes start/stop as separate notifications; we keep the
      // wire protocol unchanged so existing binaries still work.
      const method = content.state === "start" ? "startTyping" : "stopTyping";
      await client.session.request(method, { spaceId: space.id });
      return;
    }
    const proto = await spectrumToProtocol(content);
    const result = await client.session.request<{
      id: string;
      timestamp: string;
    }>("send", { spaceId: space.id, content: proto });
    return buildOutboundRecord(result, content, space.id);
  },
});
