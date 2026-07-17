const isCursor = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * Stores the latest safely accepted Fusor stream sequence for a project.
 *
 * A production implementation must durably and monotonically commit `save`
 * before its promise resolves. Use a store instance/key namespace scoped to
 * the Fusor deployment (or stream identity) as well as the project; cursors
 * must never be shared across environments or streams.
 */
export interface FusorCursorStore {
  /** Return the last committed sequence, or `undefined` for a live tail. */
  load(projectId: string): Promise<number | undefined>;

  /** Atomically advance the committed sequence without moving it backwards. */
  save(projectId: string, seq: number): Promise<void>;
}

/** Default process-local cursor storage used when no durable store is set. */
export class MemoryFusorCursorStore implements FusorCursorStore {
  private readonly cursors = new Map<string, number>();

  async load(projectId: string): Promise<number | undefined> {
    return this.cursors.get(projectId);
  }

  async save(projectId: string, seq: number): Promise<void> {
    if (!isCursor(seq)) {
      throw new Error(`fusor: invalid cursor ${seq}`);
    }
    const current = this.cursors.get(projectId);
    if (current === undefined || seq > current) {
      this.cursors.set(projectId, seq);
    }
  }
}

/** Validate values loaded from user-supplied stores before putting them on wire. */
export function normalizeFusorCursor(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!isCursor(value)) {
    throw new Error(`fusor: cursor store returned invalid cursor ${value}`);
  }
  return value;
}
