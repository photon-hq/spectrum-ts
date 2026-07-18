import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { type RemoteClient, SHARED_PHONE } from "../types";
import { parseChildId } from "./ids";

export const isSharedMode = (clients: RemoteClient[]): boolean =>
  clients.length === 1 && clients[0]?.phone === SHARED_PHONE;

export const availablePhones = (clients: RemoteClient[]): string[] =>
  clients.map((c) => c.phone);

const entryForPhone = (
  clients: RemoteClient[],
  phone: string
): RemoteClient => {
  // Shared mode: a single client serves every conversation regardless of
  // the phone arg, since the SDK exposes no per-number routing in this mode.
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
): AdvancedIMessage => entryForPhone(clients, phone).client;

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
  // intended server. Only auto-discovered dedicated entries have an
  // `instanceId` and therefore need the project-scoped Spectrum proxy.
  if (!entry.instanceId) {
    return entry.client;
  }
  if (!entry.resourceClient) {
    throw new Error(
      `Cannot access virtual iMessage resource ${resource}: the dedicated cloud token response did not provide a Spectrum proxy token`
    );
  }
  return entry.resourceClient;
};

export const clientForMessageResource = (
  clients: RemoteClient[],
  phone: string,
  messageId: string
): AdvancedIMessage => {
  const entry = entryForPhone(clients, phone);
  return isVirtualMessageResource(messageId)
    ? virtualResourceClient(entry, messageId)
    : entry.client;
};

export const clientForAttachmentResource = (
  clients: RemoteClient[],
  phone: string,
  attachmentGuid: string
): AdvancedIMessage => {
  const entry = entryForPhone(clients, phone);
  return isVirtualAttachmentResource(attachmentGuid)
    ? virtualResourceClient(entry, attachmentGuid)
    : entry.client;
};

export const clientForMiniAppSession = (
  clients: RemoteClient[],
  phone: string,
  session: { messageGuid: string; targetMessageGuid: string }
): AdvancedIMessage => {
  const entry = entryForPhone(clients, phone);
  return isVirtualMessageResource(session.messageGuid) ||
    isVirtualMessageResource(session.targetMessageGuid)
    ? virtualResourceClient(entry, session.messageGuid)
    : entry.client;
};

export const resourceClientForEntry = (
  entry: RemoteClient,
  resource: string
): AdvancedIMessage => virtualResourceClient(entry, resource);

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
