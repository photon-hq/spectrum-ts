import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let cloud: typeof import("@/utils/cloud").cloud;
let Spectrum: typeof import("@/spectrum").Spectrum;
let createTokenRenewal: typeof import("@/utils/token-renewal").createTokenRenewal;
let handle: (request: IncomingMessage, response: ServerResponse) => void;
const sockets = new Set<Socket>();
const heldSockets = new Set<Socket>();
const server = createServer((request, response) => handle(request, response));
const originalCloudUrl = process.env.SPECTRUM_CLOUD_URL;

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a local HTTP listener");
  }
  process.env.SPECTRUM_CLOUD_URL = `http://127.0.0.1:${address.port}`;
  vi.resetModules();
  ({ cloud } = await import("@/utils/cloud"));
  ({ Spectrum } = await import("@/spectrum"));
  ({ createTokenRenewal } = await import("@/utils/token-renewal"));
});

afterEach(() => {
  for (const socket of heldSockets) {
    socket.destroy();
  }
});

afterAll(async () => {
  if (originalCloudUrl === undefined) {
    delete process.env.SPECTRUM_CLOUD_URL;
  } else {
    process.env.SPECTRUM_CLOUD_URL = originalCloudUrl;
  }
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const operations = [
  [
    "project",
    (signal: AbortSignal) => cloud.getProject("project", "test-secret", signal),
  ],
  [
    "imessage",
    (signal: AbortSignal) =>
      cloud.issueImessageTokens("project", "test-secret", signal),
  ],
  [
    "whatsapp",
    (signal: AbortSignal) =>
      cloud.issueWhatsappBusinessTokens("project", "test-secret", signal),
  ],
  [
    "slack",
    (signal: AbortSignal) =>
      cloud.issueSlackTokens("project", "test-secret", signal),
  ],
  [
    "fusor",
    (signal: AbortSignal) =>
      cloud.issueFusorToken("project", "test-secret", signal),
  ],
  [
    "Spectrum project lookup",
    (signal: AbortSignal) =>
      Spectrum({
        projectId: "project",
        projectSecret: "test-secret",
        providers: [],
        signal,
      }),
  ],
] as const;

const holdResponse = (mode: "headers" | "body" | "error-body") => {
  const accepted = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let prematurelyClosed = false;
  handle = (request, response) => {
    heldSockets.add(request.socket);
    // Bun's node:http omits response.close on abort; observe the actual socket.
    request.socket.once("close", () => {
      heldSockets.delete(request.socket);
      prematurelyClosed = !response.writableFinished;
      closed.resolve();
    });
    if (mode !== "headers") {
      response.writeHead(mode === "error-body" ? 503 : 200, {
        "Content-Type": "application/json",
      });
      response.write('{"succeed":true,"data":');
    }
    accepted.resolve();
  };
  return {
    accepted: accepted.promise,
    closed: closed.promise,
    prematurelyClosed: () => prematurelyClosed,
  };
};

for (const mode of ["headers", "body", "error-body"] as const) {
  describe(`native HTTP cancellation while waiting for ${mode}`, () => {
    it.each(operations)(
      "%s aborts the transport and retains the caller reason",
      async (_name, operation) => {
        const held = holdResponse(mode);
        const controller = new AbortController();
        const outcome = operation(controller.signal).catch(
          (error: unknown) => error
        );
        await held.accepted;
        const reason = new DOMException("startup deadline", "TimeoutError");
        controller.abort(reason);
        expect(await outcome).toBe(reason);
        await held.closed;
        expect(held.prematurelyClosed()).toBe(true);
      },
      1500
    );
  });
}

it("aborts and settles a real renewal body read before disposal returns", async () => {
  const held = holdResponse("body");
  const renewal = createTokenRenewal({
    expiresInSeconds: () => 3600,
    name: "test",
    refresh: async (signal) => {
      await cloud.issueImessageTokens("project", "test-secret", signal);
    },
  });
  const refresh = renewal.forceRefresh().catch((error: unknown) => error);
  await held.accepted;
  await renewal.dispose();
  expect(await refresh).toMatchObject({ name: "AbortError" });
  await held.closed;
  expect(held.prematurelyClosed()).toBe(true);
}, 1500);

it("retains HTTP error mapping when the request was not cancelled", async () => {
  handle = (_request, response) => {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        succeed: false,
        code: "UNAVAILABLE",
        message: "test failure",
      })
    );
  };
  await expect(
    cloud.getProject("project", "test-secret")
  ).rejects.toMatchObject({
    name: "SpectrumCloudError",
    status: 503,
    code: "UNAVAILABLE",
    message: "test failure",
  });
});

it("allows successful body reads with no signal", async () => {
  const project = {
    id: "project",
    name: "Test project",
    slug: "test-project",
    profile: {},
  };
  handle = (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ succeed: true, data: project }));
  };
  expect(await cloud.getProject("project", "test-secret")).toEqual(project);
});
