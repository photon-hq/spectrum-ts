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
import z from "zod";
import { definePlatform } from "../../platform/define";
import {
  type ProtocolContent,
  type ProtocolMessageNotification,
  RpcSession,
} from "./protocol";
import { resolveTuichatBinary } from "./resolve-binary";

const commandSchema = z.object({
  name: z.string().regex(/^\/[A-Za-z0-9_-]+$/, "command must start with /"),
  description: z.string().optional(),
});

interface TerminalClient {
  messages: AsyncIterable<ProtocolMessageNotification>;
  proc: ChildProcess;
  session: RpcSession;
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

  const socketPromise = new Promise<Socket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("tuichat: subprocess did not connect within 10s"));
    }, 10_000);
    server.once("connection", (sock) => {
      clearTimeout(timeout);
      server.close();
      resolve(sock);
    });
    server.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

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

  const socket = await socketPromise;
  const session = new RpcSession(socket);

  const queue: ProtocolMessageNotification[] = [];
  const waiters: Array<
    (v: IteratorResult<ProtocolMessageNotification>) => void
  > = [];
  let closed = false;

  const iter: AsyncIterable<ProtocolMessageNotification> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ProtocolMessageNotification>> {
          if (closed && queue.length === 0) {
            return Promise.resolve({ value: undefined, done: true });
          }
          const buffered = queue.shift();
          if (buffered) {
            return Promise.resolve({ value: buffered, done: false });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  session.handleNotifications((method, params) => {
    if (method === "streamEnd") {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined, done: true });
      }
      return;
    }
    if (method !== "message") {
      return;
    }
    const msg = params as ProtocolMessageNotification;
    const w = waiters.shift();
    if (w) {
      w({ value: msg, done: false });
    } else {
      queue.push(msg);
    }
  });
  session.onClosed(() => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined, done: true });
    }
  });

  await session.request("initialize", {
    commands: options.commands,
    clientInfo: { name: "spectrum-ts", version: "terminal-provider" },
  });

  return { proc, session, messages: iter };
}

// ----- content conversion (Spectrum Content ↔ ProtocolContent) -----

type SpectrumContent = z.infer<
  typeof import("../../content/types").contentSchema
>;

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
    return {
      type: "contact",
      name: content.name
        ? {
            formatted: content.name.formatted,
            first: content.name.first,
            last: content.name.last,
          }
        : undefined,
    };
  }
  throw new Error(
    `terminal provider: unsupported content type: ${(content as { type: string }).type}`
  );
}

function protocolToSpectrum(p: ProtocolContent): SpectrumContent {
  if (p.type === "text" || p.type === "custom") {
    return p as SpectrumContent;
  }
  if (p.type === "attachment" || p.type === "voice") {
    const path = p.path;
    let bufPromise: Promise<Buffer>;
    if (p.bytes) {
      bufPromise = Promise.resolve(Buffer.from(p.bytes, "base64") as Buffer);
    } else if (path) {
      bufPromise = import("node:fs/promises").then((m) => m.readFile(path));
    } else {
      bufPromise = Promise.reject(
        new Error(`${p.type} has neither path nor bytes`)
      );
    }
    const read = async (): Promise<Buffer> => bufPromise;
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
      const buf = await bufPromise;
      return new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array(buf));
          ctrl.close();
        },
      });
    };
    const common = {
      mimeType: p.mimeType,
      size: p.size,
      read,
      stream,
    };
    if (p.type === "attachment") {
      return {
        type: "attachment",
        name: p.name,
        ...common,
      } as SpectrumContent;
    }
    return {
      type: "voice",
      name: p.name,
      ...common,
    } as SpectrumContent;
  }
  if (p.type === "contact") {
    return { type: "contact", name: p.name } as SpectrumContent;
  }
  // Fallback so unknown future shapes don't crash the agent.
  return { type: "custom", raw: p } as SpectrumContent;
}

// ----- chat-id generation (adapter side) -----

let nextChatIndex = 1;
const knownChats = new Set<string>();

function generateChatId(): string {
  while (knownChats.has(`chat-${nextChatIndex}`)) {
    nextChatIndex += 1;
  }
  const id = `chat-${nextChatIndex}`;
  nextChatIndex += 1;
  knownChats.add(id);
  return id;
}

// ----- the provider -----

export const terminal = definePlatform("terminal", {
  config: z.object({
    commands: z.array(commandSchema).optional(),
  }),

  user: {
    resolve: async ({ input }) => ({
      id: input.userID,
    }),
  },

  space: {
    params: z.object({ id: z.string().optional() }),
    resolve: async (ctx) => {
      const client = ctx.client as TerminalClient;
      const id = ctx.input.params?.id ?? generateChatId();
      knownChats.add(id);
      await client.session.request("ensureSpace", { id });
      return { id };
    },
  },

  lifecycle: {
    createClient: async ({ config }) => {
      return await spawnClient({ commands: config.commands });
    },

    destroyClient: async ({ client }) => {
      const c = client as TerminalClient;
      try {
        await c.session.request("shutdown");
      } catch {
        // best-effort
      }
      c.session.close();
      try {
        c.proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
    },
  },

  events: {
    async *messages(ctx) {
      const client = ctx.client as TerminalClient;
      for await (const msg of client.messages) {
        knownChats.add(msg.spaceId);
        yield {
          id: msg.id,
          content: protocolToSpectrum(msg.content),
          sender: { id: msg.senderId },
          space: { id: msg.spaceId },
          timestamp: new Date(msg.timestamp),
        };
      }
    },
  },

  actions: {
    send: async ({ client, content, space }) => {
      const c = client as TerminalClient;
      const proto = await spectrumToProtocol(content);
      await c.session.request("send", {
        spaceId: space.id,
        content: proto,
      });
      return { id: crypto.randomUUID(), timestamp: new Date() };
    },

    startTyping: async ({ client, space }) => {
      const c = client as TerminalClient;
      await c.session.request("startTyping", { spaceId: space.id });
    },

    stopTyping: async ({ client, space }) => {
      const c = client as TerminalClient;
      await c.session.request("stopTyping", { spaceId: space.id });
    },

    reactToMessage: async ({ client, space, messageId, reaction }) => {
      const c = client as TerminalClient;
      await c.session.request("reactToMessage", {
        spaceId: space.id,
        messageId,
        reaction,
      });
    },

    replyToMessage: async ({ client, space, messageId, content }) => {
      const c = client as TerminalClient;
      const proto = await spectrumToProtocol(content);
      await c.session.request("replyToMessage", {
        spaceId: space.id,
        messageId,
        content: proto,
      });
      return { id: crypto.randomUUID(), timestamp: new Date() };
    },
  },
});
