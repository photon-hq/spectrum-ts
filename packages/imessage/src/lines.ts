import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";
import type { RemoteClient } from "./types";

const linesLog = createLogger("spectrum.imessage.lines");

/**
 * Notified when the cloud token refresh discovers that a line was provisioned
 * or deprovisioned. Registered by the message stream so a reconciled line is
 * subscribed (or unsubscribed) without rebuilding the client array — which is
 * not an option, since three WeakMaps and core's own references are keyed by
 * that array's identity.
 *
 * `attach` means "ensure this line is subscribed" and must be idempotent: every
 * refresh re-asserts it for every known line, which is what revives a line
 * whose stream died.
 */
export interface LineObserver {
  attach(entry: RemoteClient): void;
  detach(entry: RemoteClient): Promise<void> | void;
}

const observers = new WeakMap<RemoteClient[], Set<LineObserver>>();
const lineIds = new WeakMap<RemoteClient, string>();

let fallbackKeys = 0;

/** Pairs an entry with the cloud instance it was built from. */
export const setLineId = (entry: RemoteClient, instanceId: string): void => {
  lineIds.set(entry, instanceId);
};

export const getLineId = (entry: RemoteClient): string | undefined =>
  lineIds.get(entry);

/**
 * Stable per-entry key. Falls back to a generated id for explicitly-configured
 * clients, which carry no instance id and may legitimately repeat a phone
 * number — phone alone would collide.
 */
export const lineKey = (entry: RemoteClient): string => {
  const existing = lineIds.get(entry);
  if (existing) {
    return existing;
  }
  fallbackKeys += 1;
  const generated = `line-${fallbackKeys}`;
  lineIds.set(entry, generated);
  return generated;
};

export const addLineObserver = (
  clients: RemoteClient[],
  observer: LineObserver
): void => {
  const existing = observers.get(clients);
  if (existing) {
    existing.add(observer);
    return;
  }
  observers.set(clients, new Set([observer]));
};

export const clearLineObservers = (clients: RemoteClient[]): void => {
  observers.delete(clients);
};

/**
 * Synchronous by contract: `reconcile` calls this immediately after pushing the
 * entry, with no await in between, so an observer can never see a half-applied
 * array. A throwing observer is contained — it must not be able to reject the
 * token refresh, which would stall renewal for every line.
 */
export const notifyLineAttached = (
  clients: RemoteClient[],
  entry: RemoteClient
): void => {
  for (const observer of observers.get(clients) ?? []) {
    try {
      observer.attach(entry);
    } catch (error) {
      linesLog.warn(
        "imessage line observer failed to attach",
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
  clients: RemoteClient[],
  entry: RemoteClient
): Promise<void>[] => {
  const pending: Promise<void>[] = [];
  for (const observer of observers.get(clients) ?? []) {
    try {
      pending.push(Promise.resolve(observer.detach(entry)));
    } catch (error) {
      linesLog.warn(
        "imessage line observer failed to detach",
        errorAttrs(error),
        error instanceof Error ? error : undefined
      );
    }
  }
  return pending;
};
