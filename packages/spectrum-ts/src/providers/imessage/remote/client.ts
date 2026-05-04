import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type { RemoteClient } from "../types";

export const availablePhones = (clients: RemoteClient[]): string[] =>
  clients.map((c) => c.phone);

export const clientForPhone = (
  clients: RemoteClient[],
  phone: string
): AdvancedIMessage => {
  const entry = clients.find((c) => c.phone === phone);
  if (!entry) {
    const list = availablePhones(clients).join(", ") || "<none>";
    throw new Error(
      `No iMessage client serves phone ${phone}. Available: ${list}`
    );
  }
  return entry.client;
};

export const randomPhone = (clients: RemoteClient[]): string => {
  if (clients.length === 0) {
    throw new Error("No iMessage phones configured for this account");
  }
  const entry = clients[Math.floor(Math.random() * clients.length)];
  if (!entry) {
    throw new Error("No iMessage phones configured for this account");
  }
  return entry.phone;
};
