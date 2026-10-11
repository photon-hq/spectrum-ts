import { UnsupportedError } from "@spectrum-ts/core";
import { describe, expect, it } from "vitest";
import {
  createHandle,
  type IMessageTransportHandle,
  requireStreamingClient,
} from "@/transport";
import { configSchema } from "@/types";

const STREAM_GUIDANCE = /webhooks|gRPC transport/;
const PLAINTEXT_GUIDANCE = /plaintext http:\/\//;

const handleFor = (transport: "grpc" | "http"): IMessageTransportHandle =>
  createHandle(transport, {
    address: transport === "http" ? "http://localhost:8080" : "localhost:50051",
    token: "token",
  });

describe("iMessage transport config", () => {
  it("leaves the transport unset by default", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("accepts either transport", () => {
    expect(configSchema.parse({ transport: "http" })).toEqual({
      transport: "http",
    });
    expect(configSchema.parse({ transport: "grpc" })).toEqual({
      transport: "grpc",
    });
  });

  it("rejects an unknown transport", () => {
    expect(() => configSchema.parse({ transport: "socket.io" })).toThrow();
  });
});

describe("iMessage transport factory", () => {
  it("tags the handle it builds", async () => {
    const http = handleFor("http");
    const grpc = handleFor("grpc");

    expect(http.transport).toBe("http");
    expect(grpc.transport).toBe("grpc");
    await http.client.close();
    await grpc.client.close();
  });
});

describe("iMessage http address check", () => {
  it.each([
    "http://imessage.example.com",
    "HTTP://imessage.example.com:8080",
    "http://127.example.com",
  ])("refuses plaintext http to %s", (address) => {
    expect(() => createHandle("http", { address, token: "token" })).toThrow(
      PLAINTEXT_GUIDANCE
    );
  });

  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://imessage.example.com",
    "imessage.example.com",
  ])("allows %s", async (address) => {
    const handle = createHandle("http", { address, token: "token" });

    expect(handle.transport).toBe("http");
    await handle.client.close();
  });
});

describe("iMessage streaming capability", () => {
  it("hands back the client of a grpc handle", async () => {
    const handle = handleFor("grpc");

    expect(requireStreamingClient(handle)).toBe(handle.client);
    await handle.client.close();
  });

  it("explains why an http handle cannot stream", async () => {
    const handle = handleFor("http");

    expect(() => requireStreamingClient(handle)).toThrow(UnsupportedError);
    expect(() => requireStreamingClient(handle)).toThrow(STREAM_GUIDANCE);
    await handle.client.close();
  });

  // An untagged handle predates the option, or comes from a test double, and
  // keeps the full surface it has always been assumed to have.
  it("treats an untagged handle as streaming", () => {
    const handle = {
      client: { messages: {} },
    } as unknown as IMessageTransportHandle;

    expect(requireStreamingClient(handle)).toBe(handle.client);
  });
});
