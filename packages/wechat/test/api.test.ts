import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBotQrCode,
  getQrCodeStatus,
  getUpdates,
  ILINK_PROTOCOL_VERSION,
  parseILinkJson,
  sendMessage,
} from "@/api";
import { WeChatApiError } from "@/errors";
import { BASE_URL, BOT_TOKEN, mockILink, ok, rawJson } from "./helpers";

const target = { baseUrl: BASE_URL, botToken: BOT_TOKEN };
const DECIMAL = /^\d+$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseILinkJson", () => {
  it("keeps uint64 message ids exact by parsing them as strings", () => {
    const parsed = parseILinkJson<{ msgs: { message_id: string }[] }>(
      '{"msgs":[{"message_id": 7446744073709551615}]}'
    );
    expect(parsed.msgs[0]?.message_id).toBe("7446744073709551615");
  });

  it("leaves id-looking text inside string values untouched", () => {
    const parsed = parseILinkJson<{ text: string; seq: number }>(
      '{"text":"say \\"message_id\\": 12","seq":3}'
    );
    expect(parsed).toEqual({ text: 'say "message_id": 12', seq: 3 });
  });
});

describe("iLink requests", () => {
  it("sends bot auth, app identity and base_info on bot calls", async () => {
    const ilink = mockILink({ "ilink/bot/sendmessage": ok() });

    await sendMessage(target, { to_user_id: "u" });

    const [call] = ilink.calls;
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("Authorization")).toBe(`Bearer ${BOT_TOKEN}`);
    expect(call?.headers.get("AuthorizationType")).toBe("ilink_bot_token");
    expect(call?.headers.get("iLink-App-Id")).toBe("bot");
    // 2.4.10 encoded as 0x00MMNNPP.
    expect(call?.headers.get("iLink-App-ClientVersion")).toBe(
      String(0x00_02_04_0a)
    );
    const uin = Buffer.from(
      call?.headers.get("X-WECHAT-UIN") ?? "",
      "base64"
    ).toString();
    expect(uin).toMatch(DECIMAL);
    expect(Number(uin)).toBeLessThan(2 ** 32);
    expect(call?.body).toEqual({
      msg: { to_user_id: "u" },
      base_info: {
        channel_version: ILINK_PROTOCOL_VERSION,
        bot_agent: "spectrum-ts",
      },
    });
  });

  it("starts a QR login without auth or base_info", async () => {
    const ilink = mockILink({
      "ilink/bot/get_bot_qrcode": ok({ qrcode: "q", qrcode_img_content: "u" }),
    });

    await getBotQrCode(BASE_URL);

    const [call] = ilink.calls;
    expect(call?.url.searchParams.get("bot_type")).toBe("3");
    expect(call?.headers.has("Authorization")).toBe(false);
    expect(call?.headers.get("AuthorizationType")).toBe("ilink_bot_token");
    expect(call?.body).toEqual({ local_token_list: [] });
  });

  it("polls QR status with app headers only", async () => {
    const ilink = mockILink({
      "ilink/bot/get_qrcode_status": ok({ status: "wait" }),
    });

    await getQrCodeStatus(BASE_URL, "q&1", "42");

    const [call] = ilink.calls;
    expect(call?.method).toBe("GET");
    expect(call?.url.searchParams.get("qrcode")).toBe("q&1");
    expect(call?.url.searchParams.get("verify_code")).toBe("42");
    expect(call?.headers.has("AuthorizationType")).toBe(false);
    expect(call?.headers.get("iLink-App-Id")).toBe("bot");
  });

  it("throws WeChatApiError with the business code, never the token", async () => {
    mockILink({
      "ilink/bot/sendmessage": rawJson('{"ret":-2,"errmsg":"bad request"}'),
    });

    const error = await sendMessage(target, {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WeChatApiError);
    expect(error).toMatchObject({
      endpoint: "sendmessage",
      ret: -2,
      errmsg: "bad request",
      sessionExpired: false,
    });
    expect(String(error)).not.toContain(BOT_TOKEN);
  });

  it("flags errcode -14 as an expired session", async () => {
    mockILink({ "ilink/bot/getupdates": ok({ ret: -1, errcode: -14 }) });

    await expect(getUpdates(target, "", {})).rejects.toMatchObject({
      sessionExpired: true,
    });
  });

  it("throws on HTTP errors with the status only", async () => {
    mockILink({
      "ilink/bot/getupdates": () =>
        new Response(`token ${BOT_TOKEN} rejected`, { status: 502 }),
    });

    const error = await getUpdates(target, "", {}).catch((e: unknown) => e);

    expect(error).toMatchObject({ endpoint: "getupdates", status: 502 });
    expect(String(error)).not.toContain(BOT_TOKEN);
  });
});
