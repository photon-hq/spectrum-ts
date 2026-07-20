import { afterEach, describe, expect, it, vi } from "vitest";
import { cloud, SPECTRUM_CLOUD_URL } from "@/utils/cloud";

const imessageInfoResponse = (): Response =>
  Response.json({ data: { type: "dedicated" }, succeed: true });

describe("cloud.getImessageInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the unauthenticated one-argument request", async () => {
    let requestInit: RequestInit | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      requestInit = init;
      return imessageInfoResponse();
    }) as typeof fetch);

    await expect(cloud.getImessageInfo("project-id")).resolves.toEqual({
      type: "dedicated",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      `${SPECTRUM_CLOUD_URL}/projects/project-id/imessage/`
    );
    expect(new Headers(requestInit?.headers).has("Authorization")).toBe(false);
  });

  it("attaches project Basic auth when a secret is supplied", async () => {
    let requestInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      requestInit = init;
      return imessageInfoResponse();
    }) as typeof fetch);

    await cloud.getImessageInfo("project-id", "project-secret");

    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      `Basic ${btoa("project-id:project-secret")}`
    );
  });
});

describe("cloud.issueImessageResourceToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the narrow endpoint with project Basic auth", async () => {
    let requestInit: RequestInit | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      requestInit = init;
      return Response.json({
        data: { expiresIn: 900, token: "resource-token" },
        succeed: true,
      });
    }) as typeof fetch);

    await expect(
      cloud.issueImessageResourceToken("project-id", "project-secret")
    ).resolves.toEqual({ expiresIn: 900, token: "resource-token" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      `${SPECTRUM_CLOUD_URL}/projects/project-id/imessage/resource-token`
    );
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      `Basic ${btoa("project-id:project-secret")}`
    );
  });
});
