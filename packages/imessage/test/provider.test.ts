import { afterEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({
  close: vi.fn(() => Promise.resolve()),
  createHttpClient: vi.fn(),
}));

vi.mock("@photon-ai/advanced-imessage/http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@photon-ai/advanced-imessage/http")>();
  return {
    ...actual,
    createHttpClient: httpMocks.createHttpClient.mockReturnValue({
      close: httpMocks.close,
    }),
  };
});

const { imessage } = await import("@/index");

afterEach(() => {
  vi.clearAllMocks();
});

describe("iMessage provider transport", () => {
  it("declares the Fusor definition as stream-only", () => {
    expect(imessage.config().__definition.fusor?.streamOnly).toBe(true);
  });

  it("passes explicit dedicated routing metadata to the HTTP client", async () => {
    const config = {
      clients: {
        address: "imessage-http.photon.codes",
        phone: "+15550100",
        server: "instance-one",
        token: "token-one",
      },
    };
    const definition = imessage.config(config).__definition;
    const clients = await definition.lifecycle.createClient({
      config,
      projectConfig: undefined,
      projectId: undefined,
      projectSecret: undefined,
      store: {} as never,
    });

    expect(httpMocks.createHttpClient).toHaveBeenCalledWith({
      address: "imessage-http.photon.codes",
      autoIdempotency: true,
      retry: true,
      server: "instance-one",
      token: "token-one",
    });
    await definition.lifecycle.destroyClient?.({
      client: clients,
      store: {} as never,
    });
  });

  it("keeps Fusor inbound enabled for explicit clients with project credentials", async () => {
    const config = {
      clients: {
        address: "imessage-http.photon.codes",
        phone: "+15550100",
        server: "instance-one",
        token: "token-one",
      },
    };
    const binding = await imessage.config(config).__definition.fusor?.create({
      client: [],
      config,
      projectConfig: undefined,
      projectId: "project-one",
      projectSecret: "secret-one",
      store: {} as never,
    });

    expect(binding?.platform).toBe("imessage");
  });
});
