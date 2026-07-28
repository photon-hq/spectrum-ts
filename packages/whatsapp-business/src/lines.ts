import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";

const linesLog = createLogger("spectrum.whatsapp.lines");

/**
 * Notified when the cloud token refresh discovers that a line was provisioned
 * or deprovisioned. Registered by the message stream so a reconciled line is
 * subscribed (or unsubscribed) without rebuilding the client array, whose
 * identity keys the cloud-auth state.
 *
 * `attach` means "ensure this line is subscribed" and must be idempotent: every
 * refresh re-asserts it for every known line, which is what revives a line
 * whose stream died.
 */
export interface LineObserver {
  attach(client: WhatsAppClient): void;
  detach(client: WhatsAppClient): Promise<void> | void;
}

const observers = new WeakMap<WhatsAppClient[], Set<LineObserver>>();
const lineIds = new WeakMap<WhatsAppClient, string>();

let fallbackKeys = 0;

/** Pairs a client with the phone number id it was built for. */
export const setLineId = (
  client: WhatsAppClient,
  phoneNumberId: string
): void => {
  lineIds.set(client, phoneNumberId);
};

/**
 * Stable per-client key. Falls back to a generated id for directly-configured
 * clients, which are not built from a token payload and carry no line id.
 */
export const lineKey = (client: WhatsAppClient): string => {
  const existing = lineIds.get(client);
  if (existing) {
    return existing;
  }
  fallbackKeys += 1;
  const generated = `line-${fallbackKeys}`;
  lineIds.set(client, generated);
  return generated;
};

export const addLineObserver = (
  clients: WhatsAppClient[],
  observer: LineObserver
): void => {
  const existing = observers.get(clients);
  if (existing) {
    existing.add(observer);
    return;
  }
  observers.set(clients, new Set([observer]));
};

export const clearLineObservers = (clients: WhatsAppClient[]): void => {
  observers.delete(clients);
};

/**
 * Synchronous by contract: the reconcile calls this immediately after pushing
 * the client, with no await in between, so an observer can never see a
 * half-applied array. A throwing observer is contained — it must not be able to
 * reject the token refresh, which would stall renewal for every line.
 */
export const notifyLineAttached = (
  clients: WhatsAppClient[],
  client: WhatsAppClient
): void => {
  for (const observer of observers.get(clients) ?? []) {
    try {
      observer.attach(client);
    } catch (error) {
      linesLog.warn(
        "whatsapp line observer failed to attach",
        errorAttrs(error),
        error instanceof Error ? error : undefined
      );
    }
  }
};

/**
 * Returns each observer's detach promise so the caller can settle them off the
 * refresh path — a wedged stream close must not stall token renewal.
 */
export const notifyLineDetached = (
  clients: WhatsAppClient[],
  client: WhatsAppClient
): Promise<void>[] => {
  const pending: Promise<void>[] = [];
  for (const observer of observers.get(clients) ?? []) {
    try {
      pending.push(Promise.resolve(observer.detach(client)));
    } catch (error) {
      linesLog.warn(
        "whatsapp line observer failed to detach",
        errorAttrs(error),
        error instanceof Error ? error : undefined
      );
    }
  }
  return pending;
};
