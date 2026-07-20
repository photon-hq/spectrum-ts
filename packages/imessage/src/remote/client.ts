import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
import { type RemoteClient, SHARED_PHONE } from "../types";

export const isSharedMode = (clients: RemoteClient[]): boolean =>
  clients.length === 1 && clients[0]?.phone === SHARED_PHONE;

export const availablePhones = (clients: RemoteClient[]): string[] =>
  clients.map((client) => client.phone);

export const clientEntryForPhone = (
  clients: RemoteClient[],
  phone: string
): RemoteClient => {
  // Shared mode has one HTTP middleware client for every conversation. The
  // middleware owns its internal number selection, so callers use the shared
  // sentinel rather than a physical line.
  if (isSharedMode(clients)) {
    const entry = clients[0];
    if (!entry) {
      throw new Error("No iMessage clients configured");
    }
    return entry;
  }
  const entry = clients.find((candidate) => candidate.phone === phone);
  if (!entry) {
    const list = availablePhones(clients).join(", ") || "<none>";
    throw new Error(
      `No iMessage client serves phone ${phone}. Available: ${list}`
    );
  }
  return entry;
};

export const clientForPhone = (
  clients: RemoteClient[],
  phone: string
): AdvancedIMessage => clientEntryForPhone(clients, phone).client;

export const randomPhone = (clients: RemoteClient[]): string => {
  if (clients.length === 0) {
    throw new Error("No iMessage phones configured for this account");
  }
  if (isSharedMode(clients)) {
    return SHARED_PHONE;
  }
  const entry = clients[Math.floor(Math.random() * clients.length)];
  if (!entry) {
    throw new Error("No iMessage phones configured for this account");
  }
  return entry.phone;
};
