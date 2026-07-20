import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { type RemoteClient, SHARED_PHONE } from "../types";

export const isSharedMode = (clients: RemoteClient[]): boolean =>
  clients.length === 1 && clients[0]?.phone === SHARED_PHONE;

export const availablePhones = (clients: RemoteClient[]): string[] =>
  clients.map((c) => c.phone);

export const clientForPhone = (
  clients: RemoteClient[],
  phone: string
): AdvancedIMessage => {
  // Shared mode: a single client serves every conversation regardless of
  // the phone arg, since the SDK exposes no per-number routing in this mode.
  if (isSharedMode(clients)) {
    const entry = clients[0];
    if (!entry) {
      throw new Error("No iMessage clients configured");
    }
    return entry.client;
  }
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
  if (isSharedMode(clients)) {
    return SHARED_PHONE;
  }
  const entry = clients[Math.floor(Math.random() * clients.length)];
  if (!entry) {
    throw new Error("No iMessage phones configured for this account");
  }
  return entry.phone;
};
