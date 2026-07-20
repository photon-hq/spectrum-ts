import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
import { type RemoteClient, SHARED_PHONE } from "../types";
import { parseChildId } from "./ids";

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

export const clientEntryForLine = (
  clients: RemoteClient[],
  lineId: string,
  phone: string
): RemoteClient | undefined =>
  clients.find(
    (candidate) => candidate.lineId === lineId && candidate.phone === phone
  );

export interface ImessageClientRoute {
  lineId?: string;
  phone: string;
}

/**
 * Resolve an outbound route. New dedicated spaces carry a trusted line id and
 * must match both fields; spaces persisted before this migration have no line
 * id and intentionally retain the unique-phone fallback.
 */
export const clientEntryForRoute = (
  clients: RemoteClient[],
  route: ImessageClientRoute
): RemoteClient => {
  if (route.lineId === undefined) {
    return clientEntryForPhone(clients, route.phone);
  }
  const entry = clientEntryForLine(clients, route.lineId, route.phone);
  if (!entry) {
    throw new Error(
      `No iMessage client serves line ${route.lineId} at phone ${route.phone}`
    );
  }
  return entry;
};

export const clientForPhone = (
  clients: RemoteClient[],
  phone: string
): AdvancedIMessage => clientEntryForPhone(clients, phone).client;

export const clientForRoute = (
  clients: RemoteClient[],
  route: ImessageClientRoute
): AdvancedIMessage => clientEntryForRoute(clients, route).client;

export const lineIdForPhone = (
  clients: RemoteClient[],
  phone: string
): string | undefined => clientEntryForPhone(clients, phone).lineId;

const virtualMessageGuid = (id: string): string =>
  parseChildId(id)?.parentGuid ?? id;

export const isVirtualMessageResource = (id: string): boolean => {
  const guid = virtualMessageGuid(id);
  return guid.startsWith("spc-msg-") && guid.length > "spc-msg-".length;
};

export const isVirtualAttachmentResource = (guid: string): boolean =>
  guid.startsWith("spc-att-") && guid.length > "spc-att-".length;

const virtualResourceClient = (
  entry: RemoteClient,
  resource: string
): AdvancedIMessage => {
  // Shared and explicitly configured clients already point at the caller's
  // intended server. Only auto-discovered dedicated entries have a lineId and
  // therefore need the project-scoped Spectrum proxy for historical spc-* ids.
  if (!entry.lineId) {
    return entry.client;
  }
  if (!entry.resourceClient) {
    throw new Error(
      `Cannot access virtual iMessage resource ${resource}: no Spectrum resource proxy is configured`
    );
  }
  return entry.resourceClient;
};

export const clientForMessageResource = (
  clients: RemoteClient[],
  route: ImessageClientRoute,
  messageId: string
): AdvancedIMessage => {
  const entry = clientEntryForRoute(clients, route);
  return isVirtualMessageResource(messageId)
    ? virtualResourceClient(entry, messageId)
    : entry.client;
};

export const clientForAttachmentResource = (
  clients: RemoteClient[],
  route: ImessageClientRoute,
  attachmentGuid: string
): AdvancedIMessage => {
  const entry = clientEntryForRoute(clients, route);
  return isVirtualAttachmentResource(attachmentGuid)
    ? virtualResourceClient(entry, attachmentGuid)
    : entry.client;
};

export const clientForMiniAppSession = (
  clients: RemoteClient[],
  route: ImessageClientRoute,
  session: { messageGuid: string; targetMessageGuid: string }
): AdvancedIMessage => {
  const entry = clientEntryForRoute(clients, route);
  return isVirtualMessageResource(session.messageGuid) ||
    isVirtualMessageResource(session.targetMessageGuid)
    ? virtualResourceClient(entry, session.messageGuid)
    : entry.client;
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
