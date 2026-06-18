/**
 * A small per-platform key-value bag, modeled after Swift's `UserDefaults`.
 * Untyped writes; typed reads return `undefined` on missing key OR type
 * mismatch (no throws). In-memory only.
 *
 * SDK-internal: reachable from inside `definePlatform` callbacks via the
 * `store` field on lifecycle/action/event ctx. Not exposed on the public
 * SpectrumInstance or platform narrower.
 */
export interface Store {
  array<T = unknown>(key: string): T[] | undefined;
  bool(key: string): boolean | undefined;
  clear(): void;
  delete(key: string): boolean;
  get(key: string): unknown;
  has(key: string): boolean;
  keys(): string[];
  number(key: string): number | undefined;
  object<T = Record<string, unknown>>(key: string): T | undefined;
  set(key: string, value: unknown): void;

  string(key: string): string | undefined;
}

const isRecordObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function createStore(): Store {
  const data = new Map<string, unknown>();

  return {
    set(key, value) {
      data.set(key, value);
    },
    get(key) {
      return data.get(key);
    },
    has(key) {
      return data.has(key);
    },
    delete(key) {
      return data.delete(key);
    },
    clear() {
      data.clear();
    },
    keys() {
      return Array.from(data.keys());
    },
    string(key) {
      const v = data.get(key);
      return typeof v === "string" ? v : undefined;
    },
    number(key) {
      const v = data.get(key);
      return typeof v === "number" ? v : undefined;
    },
    bool(key) {
      const v = data.get(key);
      return typeof v === "boolean" ? v : undefined;
    },
    object<T = Record<string, unknown>>(key: string): T | undefined {
      const v = data.get(key);
      if (!isRecordObject(v)) {
        return;
      }
      return v as T;
    },
    array<T = unknown>(key: string): T[] | undefined {
      const v = data.get(key);
      return Array.isArray(v) ? (v as T[]) : undefined;
    },
  };
}
