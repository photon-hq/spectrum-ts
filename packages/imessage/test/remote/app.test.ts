import type {
  AdvancedIMessage,
  MiniAppCardSession,
  MiniAppMessageResult,
} from "@photon-ai/advanced-imessage";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { asCustomizedMiniApp } from "@/content/customized-mini-app";
import { imessage } from "@/index";
import { SPECTRUM_MINI_APP, toSpectrumMiniApp } from "@/remote/app";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const SENT_DATE = new Date(1_700_000_000_000);
const MINI_APP_SESSION: MiniAppCardSession = {
  chatGuid: "any;-;+15550123",
  messageGuid: "card-guid",
  sessionId: "session-1",
  targetMessageGuid: "target-guid",
};

// A minimal `app` content with stub accessors — keeps the dispatch test off the
// network (the real `app()` would parse the layout from the URL).
const appContent = (
  url: string,
  layout: Record<string, unknown> = { caption: "Store", subcaption: "Hi" },
  live?: boolean
): Content =>
  ({
    type: "app",
    url: () => Promise.resolve(url),
    layout: () => Promise.resolve(layout),
    ...(live === undefined ? {} : { live }),
  }) as unknown as Content;

const def = imessage.config({}).__definition;
const ctx = { config: {} as never, store: undefined as never };

const miniAppResult = (
  guid = "card-guid",
  session: MiniAppCardSession = MINI_APP_SESSION
): MiniAppMessageResult =>
  ({
    guid,
    dateCreated: SENT_DATE,
    miniAppCardSession: session,
  }) as MiniAppMessageResult;

const remoteClient = (messages: Record<string, unknown>): RemoteClient[] => [
  {
    phone: SHARED_PHONE,
    client: {
      messages,
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
      Promise.resolve(miniAppResult())
    );

    const record = await def.send({
      ...ctx,
      client: remoteClient({ sendCustomizedMiniApp }),
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
    expect(sent).not.toHaveProperty("live");
    expect(record?.id).toBe("card-guid");
    expect(record?.miniAppCardSession).toEqual(MINI_APP_SESSION);
    expect(record?.timestamp).toEqual(SENT_DATE);
  });

  it("renders a live Spectrum mini-app card when requested", async () => {
    const sendCustomizedMiniApp = vi.fn((_chat: string, _content: unknown) =>
      Promise.resolve(miniAppResult())
    );

    await def.send({
      ...ctx,
      client: remoteClient({ sendCustomizedMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: appContent("https://x.example/live", { caption: "Live" }, true),
    });

    const [, sent] = sendCustomizedMiniApp.mock.calls[0] ?? [];
    expect(sent).toMatchObject({
      ...SPECTRUM_MINI_APP,
      url: "https://x.example/live",
      layout: { caption: "Live" },
      live: true,
    });
  });

  it("updates a Spectrum mini-app card via edit(app(...), message)", async () => {
    const updatedSession = { ...MINI_APP_SESSION, sessionId: "session-2" };
    const updateCustomizedMiniApp = vi.fn(
      (_session: MiniAppCardSession, _content: unknown) =>
        Promise.resolve(miniAppResult("updated-guid", updatedSession))
    );
    const target = {
      id: "card-guid",
      content: appContent("https://x.example/1"),
      direction: "outbound",
      miniAppCardSession: MINI_APP_SESSION,
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
    };

    await def.send({
      ...ctx,
      client: remoteClient({ updateCustomizedMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: {
        type: "edit",
        target: target as never,
        content: appContent("https://x.example/2", { caption: "New" }, true),
      } as never,
    });

    expect(updateCustomizedMiniApp).toHaveBeenCalledTimes(1);
    const [session, sent] = updateCustomizedMiniApp.mock.calls[0] ?? [];
    expect(session).toEqual(MINI_APP_SESSION);
    expect(sent).toMatchObject({
      ...SPECTRUM_MINI_APP,
      url: "https://x.example/2",
      layout: { caption: "New" },
      live: true,
    });
    expect(target.miniAppCardSession).toEqual(updatedSession);
  });

  it("updates a customized mini-app card via edit(customizedMiniApp(...), message)", async () => {
    const updatedSession = { ...MINI_APP_SESSION, messageGuid: "updated-guid" };
    const updateCustomizedMiniApp = vi.fn(
      (_session: MiniAppCardSession, _content: unknown) =>
        Promise.resolve(miniAppResult("updated-guid", updatedSession))
    );
    const card = asCustomizedMiniApp({
      appName: "Other",
      extensionBundleId: "com.example.Messages",
      layout: { caption: "Updated" },
      live: true,
      teamId: "ABCDE12345",
      url: "https://x.example/custom",
    });
    const target = {
      id: "card-guid",
      content: card,
      direction: "outbound",
      miniAppCardSession: MINI_APP_SESSION,
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
    };

    await def.send({
      ...ctx,
      client: remoteClient({ updateCustomizedMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: {
        type: "edit",
        target: target as never,
        content: card,
      } as never,
    });

    expect(updateCustomizedMiniApp).toHaveBeenCalledTimes(1);
    const [session, sent] = updateCustomizedMiniApp.mock.calls[0] ?? [];
    expect(session).toEqual(MINI_APP_SESSION);
    expect(sent).toEqual(card);
    expect(sent).toMatchObject({ live: true });
    expect(target.miniAppCardSession).toEqual(updatedSession);
  });

  it("sends a customized mini-app card with live preserved", async () => {
    const sendCustomizedMiniApp = vi.fn((_chat: string, _content: unknown) =>
      Promise.resolve(miniAppResult())
    );
    const card = asCustomizedMiniApp({
      appName: "Other",
      extensionBundleId: "com.example.Messages",
      layout: { caption: "Live Card" },
      live: true,
      teamId: "ABCDE12345",
      url: "https://x.example/custom-live",
    });

    const record = await def.send({
      ...ctx,
      client: remoteClient({ sendCustomizedMiniApp }),
      space: { id: "any;-;+15550123", type: "dm", phone: SHARED_PHONE },
      content: card as never,
    });

    expect(sendCustomizedMiniApp).toHaveBeenCalledTimes(1);
    const [chat, sent] = sendCustomizedMiniApp.mock.calls[0] ?? [];
    expect(chat).toBe("any;-;+15550123");
    expect(sent).toEqual(card);
    expect(sent).toMatchObject({ live: true });
    expect(record?.miniAppCardSession).toEqual(MINI_APP_SESSION);
  });
});
