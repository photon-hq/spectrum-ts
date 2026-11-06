import { afterEach, describe, expect, it, vi } from "vitest";
import { WeChatLoginError } from "@/errors";
import { loginWithQrCode } from "@/login";
import { BASE_URL, type ILinkHandler, mockILink, ok } from "./helpers";

const QR_CODE = "ilink/bot/get_bot_qrcode";
const QR_STATUS = "ilink/bot/get_qrcode_status";

const status = (body: Record<string, unknown>): ILinkHandler => ok(body);

const confirmed = status({
  status: "confirmed",
  bot_token: "new-token",
  ilink_bot_id: "bot@im.bot",
  baseurl: "https://region.ilink.test",
  ilink_user_id: "owner@im.wechat",
});

const qrCodes = (...urls: string[]): ILinkHandler[] =>
  urls.map((url, index) =>
    ok({ qrcode: `qr-${index + 1}`, qrcode_img_content: url })
  );

const login = (options: Parameters<typeof loginWithQrCode>[0] = {}) =>
  loginWithQrCode({ baseUrl: BASE_URL, pollIntervalMs: 0, ...options });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loginWithQrCode", () => {
  it("shows the QR code and resolves credentials once confirmed", async () => {
    mockILink({
      [QR_CODE]: qrCodes("https://liteapp.weixin.qq.com/q/abc"),
      [QR_STATUS]: [
        status({ status: "wait" }),
        status({ status: "scaned" }),
        confirmed,
      ],
    });
    const onQrCode = vi.fn();

    const credentials = await login({ onQrCode });

    expect(onQrCode).toHaveBeenCalledWith(
      "https://liteapp.weixin.qq.com/q/abc"
    );
    expect(credentials).toEqual({
      botToken: "new-token",
      baseUrl: "https://region.ilink.test",
      botId: "bot@im.bot",
      ownerId: "owner@im.wechat",
    });
  });

  it("replaces an expired QR code and polls the new one", async () => {
    const ilink = mockILink({
      [QR_CODE]: qrCodes("url-1", "url-2"),
      [QR_STATUS]: [status({ status: "expired" }), confirmed],
    });
    const onQrCode = vi.fn();

    await login({ onQrCode });

    expect(onQrCode.mock.calls).toEqual([["url-1"], ["url-2"]]);
    const polled = ilink
      .callsTo(QR_STATUS)
      .map((call) => call.url.searchParams.get("qrcode"));
    expect(polled).toEqual(["qr-1", "qr-2"]);
  });

  it("gives up after three QR codes expire", async () => {
    mockILink({
      [QR_CODE]: qrCodes("url-1", "url-2", "url-3"),
      [QR_STATUS]: status({ status: "expired" }),
    });

    await expect(login()).rejects.toBeInstanceOf(WeChatLoginError);
  });

  it("follows a cross-region redirect for later polls", async () => {
    const ilink = mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: [
        status({
          status: "scaned_but_redirect",
          redirect_host: "redirect.ilink.test",
        }),
        confirmed,
      ],
    });

    await login();

    const hosts = ilink.callsTo(QR_STATUS).map((call) => call.url.host);
    expect(hosts).toEqual(["ilink.test", "redirect.ilink.test"]);
  });

  it("asks for the verification number and submits it", async () => {
    const ilink = mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: [status({ status: "need_verifycode" }), confirmed],
    });
    const onVerifyCode = vi.fn(() => " 1234 ");

    await login({ onVerifyCode });

    expect(onVerifyCode).toHaveBeenCalledOnce();
    expect(
      ilink.callsTo(QR_STATUS)[1]?.url.searchParams.get("verify_code")
    ).toBe("1234");
  });

  it("fails clearly when verification is needed but no handler is set", async () => {
    mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: status({ status: "need_verifycode" }),
    });

    await expect(login()).rejects.toMatchObject({
      name: "WeChatLoginError",
      status: "need_verifycode",
    });
  });

  it("treats a failed status poll as 'still waiting'", async () => {
    mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: [() => new Response("gateway", { status: 524 }), confirmed],
    });

    await expect(login()).resolves.toMatchObject({ botToken: "new-token" });
  });

  it("rejects an already-bound account", async () => {
    mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: status({ status: "binded_redirect" }),
    });

    await expect(login()).rejects.toMatchObject({ status: "binded_redirect" });
  });

  it("rejects a confirmation without a bot token", async () => {
    mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: status({ status: "confirmed" }),
    });

    await expect(login()).rejects.toBeInstanceOf(WeChatLoginError);
  });

  it("times out while nobody scans", async () => {
    mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: status({ status: "wait" }),
    });

    await expect(login({ timeoutMs: 20 })).rejects.toMatchObject({
      name: "WeChatLoginError",
      status: "wait",
    });
  });

  it("stops when the startup signal aborts", async () => {
    mockILink({
      [QR_CODE]: qrCodes("url"),
      [QR_STATUS]: status({ status: "wait" }),
    });
    const controller = new AbortController();

    const pending = login({ signal: controller.signal });
    controller.abort(new Error("startup cancelled"));

    await expect(pending).rejects.toThrow("startup cancelled");
  });
});
