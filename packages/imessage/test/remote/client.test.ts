import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
import { describe, expect, it, vi } from "vitest";
import {
  availablePhones,
  clientEntryForPhone,
  clientForPhone,
  isSharedMode,
  randomPhone,
} from "@/remote/client";
import type { RemoteClient } from "@/types";
import { SHARED_PHONE } from "@/types";

const remote = (name: string): AdvancedIMessage =>
  ({ name }) as unknown as AdvancedIMessage;

const dedicated = (name: string, phone: string): RemoteClient => ({
  client: remote(name),
  phone,
});

describe("iMessage HTTP client routing", () => {
  it("recognizes only the single shared middleware client as shared mode", () => {
    const shared = { client: remote("shared"), phone: SHARED_PHONE };

    expect(isSharedMode([shared])).toBe(true);
    expect(isSharedMode([])).toBe(false);
    expect(isSharedMode([dedicated("line", "+15550100")])).toBe(false);
    expect(isSharedMode([shared, dedicated("line", "+15550100")])).toBe(false);
  });

  it("lists configured phones in client order", () => {
    expect(
      availablePhones([
        dedicated("first", "+15550100"),
        dedicated("second", "+15550200"),
      ])
    ).toEqual(["+15550100", "+15550200"]);
  });

  it("routes every shared-mode phone through the middleware client", () => {
    const shared = { client: remote("shared"), phone: SHARED_PHONE };

    expect(clientEntryForPhone([shared], "+15550100")).toBe(shared);
    expect(clientForPhone([shared], "+15550100")).toBe(shared.client);
  });

  it("routes dedicated clients by exact phone", () => {
    const first = dedicated("first", "+15550100");
    const second = dedicated("second", "+15550200");

    expect(clientEntryForPhone([first, second], second.phone)).toBe(second);
    expect(clientForPhone([first, second], first.phone)).toBe(first.client);
  });

  it("fails with the available phones when no dedicated client matches", () => {
    const clients = [
      dedicated("first", "+15550100"),
      dedicated("second", "+15550200"),
    ];

    expect(() => clientEntryForPhone(clients, "+15550999")).toThrow(
      "No iMessage client serves phone +15550999. Available: +15550100, +15550200"
    );
    expect(() => clientEntryForPhone([], "+15550999")).toThrow(
      "No iMessage client serves phone +15550999. Available: <none>"
    );
  });

  it("chooses a configured dedicated phone", () => {
    const selectSecondClient = 0.75;
    const clients = [
      dedicated("first", "+15550100"),
      dedicated("second", "+15550200"),
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
