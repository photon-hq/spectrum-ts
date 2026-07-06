import type {
  AdvancedIMessage,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { imessage } from "@/index";
import { SPECTRUM_MINI_APP, toSpectrumMiniApp } from "@/remote/app";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const SENT_DATE = new Date(1_700_000_000_000);

// A minimal `app` content with stub accessors — keeps the dispatch test off the
// network (the real `app()` would parse the layout from the URL).
const appContent = (
  url: string,
  layout: Record<string, unknown> = { caption: "Store", subcaption: "Hi" }
): Content =>
  ({
    type: "app",
    url: () => Promise.resolve(url),
    layout: () => Promise.resolve(layout),
  }) as unknown as Content;

const def = imessage.config({}).__definition;
const ctx = { config: {} as never, store: undefined as never };

const remoteClient = (
  sendCustomizedMiniApp: (chat: string, content: unknown) => Promise<SDKMessage>
): RemoteClient[] => [
  {
    phone: SHARED_PHONE,
    client: {
      messages: { sendCustomizedMiniApp },
    } as unknown as AdvancedIMessage,
  },
];

describe("toSpectrumMiniApp", () => {
  it("merges Spectrum's fixed identity with the url and layout", () => {
    const card = toSpectrumMiniApp("https://x.example/1", { caption: "C" });
    expect(card).toMatchObject({
      type: "customized-mini-app",
      __platform: "iMessage",
      ...SPECTRUM_MINI_APP,
      url: "https://x.example/1",
      layout: { caption: "C" },
    });
  });
});

describe("iMessage send: app dispatch", () => {
  it("renders a Spectrum mini-app card on remote", async () => {
    const sendCustomizedMiniApp = vi.fn((_chat: string, _content: unknown) =>
      Promise.resolve({
        guid: "card-guid",
        dateCreated: SENT_DATE,
      } as unknown as SDKMessage)
    );

    const record = await def.send({
      ...ctx,
      client: remoteClient(sendCustomizedMiniApp),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: appContent("https://x.example/1"),
    });

    expect(sendCustomizedMiniApp).toHaveBeenCalledTimes(1);
    const [chat, sent] = sendCustomizedMiniApp.mock.calls[0] ?? [];
    expect(chat).toBe("any;-;+15550123");
    expect(sent).toMatchObject({
      ...SPECTRUM_MINI_APP,
      url: "https://x.example/1",
      layout: { caption: "Store", subcaption: "Hi" },
    });
    expect(record?.id).toBe("card-guid");
    expect(record?.timestamp).toEqual(SENT_DATE);
  });

  it("degrades to a bare-url text message in local mode", async () => {
    const send = vi.fn((_: unknown) => Promise.resolve());
    const localClient = Object.assign(Object.create(IMessageSDK.prototype), {
      send,
    }) as IMessageSDK;

    await def.send({
      ...ctx,
      client: localClient,
      space: { id: "any;-;x", type: "dm", phone: SHARED_PHONE },
      content: appContent("https://x.example/2"),
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: "any;-;x",
      text: "https://x.example/2",
    });
  });
});
