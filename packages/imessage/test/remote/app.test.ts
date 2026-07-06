import { describe, expect, it, mock } from "bun:test";
import type {
  AdvancedIMessage,
  MiniAppMessageResult,
} from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Content } from "@spectrum-ts/core";
import { asCustomizedMiniApp } from "@/content/customized-mini-app";
import { imessage } from "@/index";
import { toSpectrumMiniApp } from "@/remote/app";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const SENT_DATE = new Date(1_700_000_000_000);
const MINI_APP_SESSION = {
  chatGuid: "any;-;+15550123",
  messageGuid: "card-guid",
  sessionId: "session-id",
  targetMessageGuid: "card-guid",
};

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

const remoteClient = (messages: Record<string, unknown>): RemoteClient[] => [
  {
    phone: SHARED_PHONE,
    client: {
      messages,
    } as unknown as AdvancedIMessage,
  },
];

describe("toSpectrumMiniApp", () => {
  it("maps app layout to the server-managed mini-app preview", () => {
    const card = toSpectrumMiniApp("https://x.example/1", { caption: "C" });
    expect(card).toEqual({
      url: "https://x.example/1",
      preview: {
        title: "C",
        body: undefined,
        caption: "C",
        detail: undefined,
        footer: undefined,
        imageJpeg: undefined,
        subtitle: undefined,
        summary: "C",
      },
    });
  });
});

describe("iMessage send: app dispatch", () => {
  it("renders a Spectrum mini-app card on remote", async () => {
    const sendMiniApp = mock((_chat: string, _content: unknown) =>
      Promise.resolve({
        guid: "card-guid",
        dateCreated: SENT_DATE,
        miniAppCardSession: MINI_APP_SESSION,
      } as unknown as MiniAppMessageResult)
    );

    const record = await def.send({
      ...ctx,
      client: remoteClient({ sendMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: appContent("https://x.example/1"),
    });

    expect(sendMiniApp).toHaveBeenCalledTimes(1);
    const [chat, sent] = sendMiniApp.mock.calls[0] ?? [];
    expect(chat).toBe("any;-;+15550123");
    expect(sent).toEqual({
      url: "https://x.example/1",
      preview: {
        title: "Store",
        subtitle: undefined,
        body: "Hi",
        imageJpeg: undefined,
        caption: "Store",
        footer: undefined,
        detail: undefined,
        summary: "Store",
      },
    });
    expect(record?.id).toBe("card-guid");
    expect(record?.miniAppCardSession).toEqual(MINI_APP_SESSION);
    expect(record?.timestamp).toEqual(SENT_DATE);
    expect(record?.content.type).toBe("app");
  });

  it("updates a Spectrum mini-app card via edit(app(...), message)", async () => {
    const updatedSession = {
      ...MINI_APP_SESSION,
      messageGuid: "updated-card-guid",
    };
    const updateMiniApp = mock((_session: unknown, _content: unknown) =>
      Promise.resolve({
        guid: "updated-card-guid",
        dateCreated: SENT_DATE,
        miniAppCardSession: updatedSession,
      } as unknown as MiniAppMessageResult)
    );
    const target = {
      id: "card-guid",
      content: appContent("https://x.example/1"),
      direction: "outbound",
      miniAppCardSession: MINI_APP_SESSION,
    };

    await def.send({
      ...ctx,
      client: remoteClient({ updateMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: {
        type: "edit",
        content: appContent("https://x.example/2", { caption: "Updated" }),
        target,
      } as unknown as Content,
    });

    expect(updateMiniApp).toHaveBeenCalledTimes(1);
    const [session, sent] = updateMiniApp.mock.calls[0] ?? [];
    expect(session).toEqual(MINI_APP_SESSION);
    expect(sent).toEqual({
      url: "https://x.example/2",
      preview: {
        title: "Updated",
        subtitle: undefined,
        body: undefined,
        imageJpeg: undefined,
        caption: "Updated",
        footer: undefined,
        detail: undefined,
        summary: "Updated",
      },
    });
    expect(target.miniAppCardSession).toEqual(updatedSession);

    await def.send({
      ...ctx,
      client: remoteClient({ updateMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: {
        type: "edit",
        content: appContent("https://x.example/3", { caption: "Again" }),
        target,
      } as unknown as Content,
    });

    expect(updateMiniApp.mock.calls[1]?.[0]).toEqual(updatedSession);
  });

  it("updates a customized mini-app card via edit(customizedMiniApp(...), message)", async () => {
    const updatedSession = {
      ...MINI_APP_SESSION,
      messageGuid: "updated-custom-guid",
    };
    const updated = asCustomizedMiniApp({
      appName: "Custom App",
      appStoreId: 123,
      extensionBundleId: "com.example.MessagesExtension",
      layout: { caption: "Custom Updated" },
      teamId: "ABCDE12345",
      url: "https://x.example/custom-updated",
    });
    const updateCustomizedMiniApp = mock(
      (_session: unknown, _content: unknown) =>
        Promise.resolve({
          guid: "updated-custom-guid",
          dateCreated: SENT_DATE,
          miniAppCardSession: updatedSession,
        } as unknown as MiniAppMessageResult)
    );
    const target = {
      id: "custom-card-guid",
      content: asCustomizedMiniApp({
        appName: "Custom App",
        extensionBundleId: "com.example.MessagesExtension",
        layout: { caption: "Custom" },
        teamId: "ABCDE12345",
        url: "https://x.example/custom",
      }),
      direction: "outbound",
      miniAppCardSession: MINI_APP_SESSION,
    };

    await def.send({
      ...ctx,
      client: remoteClient({ updateCustomizedMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: {
        type: "edit",
        content: updated,
        target,
      } as unknown as Content,
    });

    expect(updateCustomizedMiniApp).toHaveBeenCalledTimes(1);
    const [session, sent] = updateCustomizedMiniApp.mock.calls[0] ?? [];
    expect(session).toEqual(MINI_APP_SESSION);
    expect(sent).toMatchObject({
      appName: "Custom App",
      appStoreId: 123,
      extensionBundleId: "com.example.MessagesExtension",
      layout: { caption: "Custom Updated" },
      teamId: "ABCDE12345",
      url: "https://x.example/custom-updated",
    });
    expect(target.miniAppCardSession).toEqual(updatedSession);
  });

  it("degrades to a bare-url text message in local mode", async () => {
    const send = mock((_: unknown) => Promise.resolve());
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
