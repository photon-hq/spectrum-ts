import { createLogger } from "@photon-ai/otel";
import { type ManagedStream, stream } from "./stream";
import { errorAttrs } from "./telemetry";

const groupLog = createLogger("spectrum.stream");

/**
 * Builds a member stream. Invoked once per attach — and again on re-attach, so
 * a member that faulted can be revived by adding its key back.
 */
export type StreamGroupSource<T> = () => ManagedStream<T>;

export interface StreamGroupOptions {
  /** Log provenance, e.g. `"imessage.messages"`. */
  label?: string;
}

export interface StreamGroup<T> extends ManagedStream<T> {
  /**
   * Attach `key`. Returns false — without invoking `source`, which typically
   * opens a subscription — when the key is already attached or the group is
   * closed. Safe before the group has a consumer: the factory runs when the
   * group first starts.
   */
  add(key: string, source: StreamGroupSource<T>): boolean;
  has(key: string): boolean;
  /** Attached keys, in attach order. */
  keys(): string[];
  /**
   * Detach `key` and close its source. Resolves once that source's own
   * `close()` settles; it deliberately does not wait on the member's worker,
   * which unparks only when the group's consumer pulls. Returns false when the
   * key was not attached.
   */
  remove(key: string): Promise<boolean>;
}

interface Member<T> {
  detached: boolean;
  factory: StreamGroupSource<T>;
  source?: ManagedStream<T>;
  worker?: Promise<void>;
}

/**
 * A merged stream whose membership can change while it runs.
 *
 * Sibling of `mergeStreams`, with a deliberately different lifetime contract —
 * pick by whether the source set is fixed:
 *
 *   - `mergeStreams` merges a *fixed* set. Its result represents all of them:
 *     it ends when they have all ended (immediately, for an empty set) and one
 *     member's error ends the whole merge.
 *   - `createStreamGroup` owns a *mutable* set. It ends only via `close()` —
 *     zero members parks the consumer rather than ending it, so a set that is
 *     briefly empty mid-reconcile does not terminate the stream — and a member
 *     that fails is logged and dropped while its siblings keep running.
 *
 * Dropping a faulted member (rather than restarting it here) keeps retry policy
 * with the caller that knows the real inventory: `keys()` stops reporting it, so
 * the caller's next reconcile re-adds it through `add`.
 */
export function createStreamGroup<T>(
  options: StreamGroupOptions = {}
): StreamGroup<T> {
  const label = options.label ?? "stream-group";
  const members = new Map<string, Member<T>>();
  let closed = false;
  // Assigned when the underlying stream starts, since `emit` only exists inside
  // the setup callback. Its absence is what makes pre-start `add` calls lazy.
  let spawn: ((key: string, member: Member<T>) => void) | undefined;

  const memberAttrs = (key: string) => ({
    "spectrum.stream.group": label,
    "spectrum.stream.member": key,
  });

  // A member only reaches here by ending or throwing on its own, which for a
  // reconnecting source means a bug — never a detach, which exits silently.
  const reportMemberExit = (
    key: string,
    member: Member<T>,
    error?: unknown
  ): void => {
    if (member.detached) {
      return;
    }
    if (error === undefined) {
      groupLog.error(
        "stream group member ended unexpectedly",
        memberAttrs(key)
      );
      return;
    }
    groupLog.error(
      "stream group member failed",
      { ...memberAttrs(key), ...errorAttrs(error) },
      error instanceof Error ? error : undefined
    );
  };

  const runMember = async (
    key: string,
    member: Member<T>,
    emit: (value: T) => Promise<void>
  ): Promise<void> => {
    try {
      const source = member.factory();
      member.source = source;
      for await (const value of source) {
        await emit(value);
      }
      reportMemberExit(key, member);
    } catch (error) {
      reportMemberExit(key, member, error ?? new Error("unknown stream error"));
    } finally {
      // Drop the faulted member so `keys()` reports the truth and the caller's
      // next reconcile can re-add it. Guarded against a re-add that already
      // replaced this member under the same key.
      if (members.get(key) === member) {
        members.delete(key);
      }
    }
  };

  const base = stream<T>((emit) => {
    spawn = (key, member) => {
      member.worker = runMember(key, member, emit);
    };

    for (const [key, member] of members) {
      spawn(key, member);
    }

    return async () => {
      const attached = Array.from(members.values());
      // Teardown is not a fault. Marking every member detached first keeps a
      // normal shutdown — `close()` or the consumer walking away — from
      // reporting one bogus member failure per source.
      for (const member of attached) {
        member.detached = true;
      }
      // Sources first, then workers: a worker parked on `emit` unparks only
      // once the stream has stopped, which has already happened by the time
      // cleanup runs. Members detached earlier are deliberately absent — their
      // workers are not awaited.
      await Promise.allSettled(
        attached.map((member) => member.source?.close())
      );
      await Promise.allSettled(attached.map((member) => member.worker));
    };
  });

  const closeBase = base.close.bind(base);

  return Object.assign(base, {
    add: (key: string, source: StreamGroupSource<T>): boolean => {
      if (closed || members.has(key)) {
        return false;
      }
      const member: Member<T> = { detached: false, factory: source };
      members.set(key, member);
      spawn?.(key, member);
      return true;
    },

    close: async (): Promise<void> => {
      closed = true;
      await closeBase();
    },

    has: (key: string): boolean => members.has(key),

    keys: (): string[] => Array.from(members.keys()),

    remove: async (key: string): Promise<boolean> => {
      const member = members.get(key);
      if (!member) {
        return false;
      }
      // Marked before the delete so the worker's exit reads as intentional and
      // stays silent.
      member.detached = true;
      members.delete(key);
      await member.source?.close();
      return true;
    },
  });
}
