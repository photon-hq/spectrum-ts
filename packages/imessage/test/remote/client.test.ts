import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
import { describe, expect, it, vi } from "vitest";
import {
  availablePhones,
  clientEntryForLine,
  clientEntryForPhone,
  clientEntryForRoute,
  clientForAttachmentResource,
  clientForMessageResource,
  clientForMiniAppSession,
  clientForPhone,
  clientForRoute,
  isSharedMode,
  isVirtualAttachmentResource,
  isVirtualMessageResource,
  lineIdForPhone,
  randomPhone,
} from "@/remote/client";
import type { RemoteClient } from "@/types";
import { SHARED_PHONE } from "@/types";

const remote = (name: string): AdvancedIMessage =>
  ({ name }) as unknown as AdvancedIMessage;

const dedicated = (
  name: string,
  lineId: string,
  phone: string,
  resourceClient?: AdvancedIMessage
): RemoteClient => ({ client: remote(name), lineId, phone, resourceClient });

describe("iMessage HTTP client routing", () => {
  it("recognizes only the single shared middleware client as shared mode", () => {
    const shared = { client: remote("shared"), phone: SHARED_PHONE };

    expect(isSharedMode([shared])).toBe(true);
    expect(isSharedMode([])).toBe(false);
    expect(isSharedMode([dedicated("line", "line-1", "+15550100")])).toBe(
      false
    );
    expect(
      isSharedMode([shared, dedicated("line", "line-1", "+15550100")])
    ).toBe(false);
  });

  it("lists configured phones in client order", () => {
    expect(
      availablePhones([
        dedicated("first", "line-1", "+15550100"),
        dedicated("second", "line-2", "+15550200"),
      ])
    ).toEqual(["+15550100", "+15550200"]);
  });

  it("routes every shared-mode phone through the middleware client", () => {
    const shared = { client: remote("shared"), phone: SHARED_PHONE };

    expect(clientEntryForPhone([shared], "+15550100")).toBe(shared);
    expect(clientForPhone([shared], "+15550100")).toBe(shared.client);
    expect(lineIdForPhone([shared], "+15550100")).toBeUndefined();
  });

  it("routes dedicated clients by exact phone", () => {
    const first = dedicated("first", "line-1", "+15550100");
    const second = dedicated("second", "line-2", "+15550200");

    expect(clientEntryForPhone([first, second], second.phone)).toBe(second);
    expect(clientForPhone([first, second], first.phone)).toBe(first.client);
    expect(lineIdForPhone([first, second], second.phone)).toBe("line-2");
  });

  it("fails with the available phones when no dedicated client matches", () => {
    const clients = [
      dedicated("first", "line-1", "+15550100"),
      dedicated("second", "line-2", "+15550200"),
    ];

    expect(() => clientEntryForPhone(clients, "+15550999")).toThrow(
      "No iMessage client serves phone +15550999. Available: +15550100, +15550200"
    );
    expect(() => clientEntryForPhone([], "+15550999")).toThrow(
      "No iMessage client serves phone +15550999. Available: <none>"
    );
  });

  it("matches a dedicated line only when both its id and phone agree", () => {
    const first = dedicated("first", "line-1", "+15550100");
    const second = dedicated("second", "line-2", "+15550200");
    const clients = [first, second];

    expect(clientEntryForLine(clients, "line-2", "+15550200")).toBe(second);
    expect(clientEntryForLine(clients, "line-2", "+15550100")).toBeUndefined();
    expect(clientEntryForLine(clients, "line-1", "+15550200")).toBeUndefined();
    expect(clientEntryForLine(clients, "missing", "+15550999")).toBeUndefined();
  });

  it("requires an exact line and phone match when a space carries lineId", () => {
    const first = dedicated("first", "line-1", "+15550100");
    const second = dedicated("second", "line-2", "+15550200");
    const clients = [first, second];

    expect(
      clientEntryForRoute(clients, {
        lineId: "line-2",
        phone: "+15550200",
      })
    ).toBe(second);
    expect(
      clientForRoute(clients, { lineId: "line-1", phone: "+15550100" })
    ).toBe(first.client);
    expect(() =>
      clientEntryForRoute(clients, {
        lineId: "line-1",
        phone: "+15550200",
      })
    ).toThrow("No iMessage client serves line line-1 at phone +15550200");
  });

  it("falls back to phone only for spaces created before lineId existed", () => {
    const entry = dedicated("line", "line-1", "+15550100");

    expect(clientEntryForRoute([entry], { phone: entry.phone })).toBe(entry);
  });

  it("routes native resources through the line-scoped client", () => {
    const entry = dedicated("line", "line-1", "+15550100");
    const route = { phone: entry.phone };

    expect(clientForMessageResource([entry], route, "native-message")).toBe(
      entry.client
    );
    expect(
      clientForAttachmentResource([entry], route, "native-attachment")
    ).toBe(entry.client);
    expect(
      clientForMiniAppSession([entry], route, {
        messageGuid: "native-message",
        targetMessageGuid: "native-target",
      })
    ).toBe(entry.client);
  });

  it("recognizes virtual parent, child, and attachment resources", () => {
    expect(isVirtualMessageResource("spc-msg-parent")).toBe(true);
    expect(isVirtualMessageResource("p:2/spc-msg-parent")).toBe(true);
    expect(isVirtualMessageResource("spc-msg-")).toBe(false);
    expect(isVirtualMessageResource("native-message")).toBe(false);
    expect(isVirtualAttachmentResource("spc-att-file")).toBe(true);
    expect(isVirtualAttachmentResource("spc-att-")).toBe(false);
    expect(isVirtualAttachmentResource("native-attachment")).toBe(false);
  });

  it("routes historical dedicated virtual resources through the project proxy", () => {
    const proxy = remote("proxy");
    const entry = dedicated("line", "line-1", "+15550100", proxy);
    const route = { lineId: entry.lineId, phone: entry.phone };

    expect(clientForMessageResource([entry], route, "p:2/spc-msg-parent")).toBe(
      proxy
    );
    expect(clientForAttachmentResource([entry], route, "spc-att-file")).toBe(
      proxy
    );
    expect(
      clientForMiniAppSession([entry], route, {
        messageGuid: "spc-msg-card",
        targetMessageGuid: "native-target",
      })
    ).toBe(proxy);
  });

  it("fails closed when a dedicated virtual resource has no project proxy", () => {
    const entry = dedicated("line", "line-1", "+15550100");

    expect(() =>
      clientForMessageResource(
        [entry],
        { lineId: entry.lineId, phone: entry.phone },
        "spc-msg-parent"
      )
    ).toThrow(
      "Cannot access virtual iMessage resource spc-msg-parent: no Spectrum resource proxy is configured"
    );
  });

  it("chooses a configured dedicated phone", () => {
    const selectSecondClient = 0.75;
    const clients = [
      dedicated("first", "line-1", "+15550100"),
      dedicated("second", "line-2", "+15550200"),
    ];
    const random = vi.spyOn(Math, "random").mockReturnValue(selectSecondClient);

    expect(randomPhone(clients)).toBe("+15550200");

    random.mockRestore();
  });

  it("returns the shared sentinel and rejects an empty account", () => {
    expect(
      randomPhone([{ client: remote("shared"), phone: SHARED_PHONE }])
    ).toBe(SHARED_PHONE);
    expect(() => randomPhone([])).toThrow(
      "No iMessage phones configured for this account"
    );
  });
});
