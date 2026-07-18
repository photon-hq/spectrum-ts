import type {
  AdvancedIMessage,
  MiniAppCardSession,
} from "@photon-ai/advanced-imessage/grpc";
import { describe, expect, it } from "vitest";
import {
  clientForAttachmentResource,
  clientForMessageResource,
  clientForMiniAppSession,
  isVirtualAttachmentResource,
  isVirtualMessageResource,
} from "@/remote/client";
import type { RemoteClient } from "@/types";
import { SHARED_PHONE } from "@/types";

const MISSING_PROXY_CLIENT_ERROR = /did not provide a Spectrum proxy token/;

const remote = (name: string): AdvancedIMessage =>
  ({ name }) as unknown as AdvancedIMessage;

const dedicated = (): {
  direct: AdvancedIMessage;
  entry: RemoteClient;
  proxy: AdvancedIMessage;
} => {
  const direct = remote("direct");
  const proxy = remote("proxy");
  return {
    direct,
    entry: {
      client: direct,
      instanceId: "instance-1",
      phone: "+15550100",
      resourceClient: proxy,
    },
    proxy,
  };
};

describe("iMessage virtual resource client routing", () => {
  it("recognizes message parents, child ids, and attachment resources", () => {
    expect(isVirtualMessageResource("spc-msg-parent")).toBe(true);
    expect(isVirtualMessageResource("p:3/spc-msg-parent")).toBe(true);
    expect(isVirtualMessageResource("p:3/native-parent")).toBe(false);
    expect(isVirtualMessageResource("spc-msg-")).toBe(false);
    expect(isVirtualAttachmentResource("spc-att-photo")).toBe(true);
    expect(isVirtualAttachmentResource("spc-att-")).toBe(false);
  });

  it("keeps native dedicated resources on their instance client", () => {
    const { direct, entry } = dedicated();

    expect(
      clientForMessageResource([entry], entry.phone, "native-message")
    ).toBe(direct);
    expect(
      clientForAttachmentResource([entry], entry.phone, "native-attachment")
    ).toBe(direct);
  });

  it("routes virtual messages, child ids, attachments, and sessions to the shared proxy", () => {
    const { entry, proxy } = dedicated();
    const virtualSession = {
      chatGuid: "any;-;+15551234",
      messageGuid: "spc-msg-card",
      sessionId: "session-1",
      targetMessageGuid: "spc-msg-target",
    } satisfies MiniAppCardSession;

    expect(
      clientForMessageResource([entry], entry.phone, "spc-msg-parent")
    ).toBe(proxy);
    expect(
      clientForMessageResource([entry], entry.phone, "p:2/spc-msg-parent")
    ).toBe(proxy);
    expect(
      clientForAttachmentResource([entry], entry.phone, "spc-att-photo")
    ).toBe(proxy);
    expect(clientForMiniAppSession([entry], entry.phone, virtualSession)).toBe(
      proxy
    );
  });

  it("keeps native mini-app sessions on the dedicated instance", () => {
    const { direct, entry } = dedicated();
    const session = {
      chatGuid: "any;-;+15551234",
      messageGuid: "native-card",
      sessionId: "session-1",
      targetMessageGuid: "native-target",
    } satisfies MiniAppCardSession;

    expect(clientForMiniAppSession([entry], entry.phone, session)).toBe(direct);
  });

  it("leaves shared and explicitly configured clients unchanged", () => {
    const shared = remote("shared");
    const explicit = remote("explicit");

    expect(
      clientForMessageResource(
        [{ client: shared, phone: SHARED_PHONE }],
        SHARED_PHONE,
        "spc-msg-shared"
      )
    ).toBe(shared);
    expect(
      clientForAttachmentResource(
        [{ client: explicit, phone: "+15550100" }],
        "+15550100",
        "spc-att-explicit"
      )
    ).toBe(explicit);
  });

  it("fails clearly instead of sending a virtual id to a dedicated server", () => {
    const entry: RemoteClient = {
      client: remote("direct"),
      instanceId: "instance-1",
      phone: "+15550100",
    };

    expect(() =>
      clientForMessageResource([entry], entry.phone, "spc-msg-missing")
    ).toThrow(MISSING_PROXY_CLIENT_ERROR);
  });
});
