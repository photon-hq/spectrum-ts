import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";

const REMOTE_CLIENT_MISSING = "No remote iMessage client available";

export const firstRemoteClient = (
  clients: AdvancedIMessage[]
): AdvancedIMessage | undefined => clients[0];

export const primaryRemoteClient = (
  clients: AdvancedIMessage[]
): AdvancedIMessage => {
  const remote = firstRemoteClient(clients);
  if (!remote) {
    throw new Error(REMOTE_CLIENT_MISSING);
  }
  return remote;
};
