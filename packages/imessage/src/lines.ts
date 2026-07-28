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

/**
 * Registers `observer` and returns a disposer that removes just this one, so a
 * closed message stream stops being called into. `clearLineObservers` remains
 * the whole-array teardown used when the client itself is destroyed.
 */
export const addLineObserver = (
  clients: RemoteClient[],
  observer: LineObserver
): (() => void) => {
  const existing = observers.get(clients);
  if (existing) {
    existing.add(observer);
  } else {
    observers.set(clients, new Set([observer]));
  }

  return () => {
    const current = observers.get(clients);
    if (!current?.delete(observer)) {
      return;
    }
    if (current.size === 0) {
      observers.delete(clients);
    }
  };
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
