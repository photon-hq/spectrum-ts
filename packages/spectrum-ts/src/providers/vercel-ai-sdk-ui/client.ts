import type { ProviderMessage } from "../../platform/types";
import type { AsyncQueue } from "./queue";
import { makeAsyncQueue } from "./queue";
import type { PendingResponseSession } from "./session";

// Provider-local state. Phase 1 is intentionally process-local: inbound
// browser messages are queued in memory and pending HTTP responses are matched
// by space id until a first text send completes them.
export type VercelAiSdkUIMessage = ProviderMessage<
  { id: string },
  { id: string },
  Record<never, never>
>;

export interface VercelAiSdkUIClient {
  close: () => void;
  inbound: AsyncQueue<VercelAiSdkUIMessage>;
  pendingBySpaceId: Map<string, PendingResponseSession[]>;
}

export function createClient(): VercelAiSdkUIClient {
  const inbound = makeAsyncQueue<VercelAiSdkUIMessage>();
  const pendingBySpaceId = new Map<string, PendingResponseSession[]>();

  return {
    inbound,
    pendingBySpaceId,
    close: () => {
      inbound.close();
      // Close every open response session so Spectrum.stop() cannot leave a
      // useChat route waiting on a writer that will never receive more text.
      for (const sessions of pendingBySpaceId.values()) {
        for (const session of sessions) {
          session.close();
        }
      }
      pendingBySpaceId.clear();
    },
  };
}
