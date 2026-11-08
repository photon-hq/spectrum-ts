import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "@spectrum-ts/core";
import z from "zod";
import type { WeChatCredentials } from "./types";

// Spectrum's per-provider `store` holds the live state; it is in-memory only,
// so an optional JSON file mirrors it across restarts.
const CREDENTIALS_KEY = "wechat.credentials";
const CURSOR_KEY = "wechat.cursor";
const CONTEXT_TOKENS_KEY = "wechat.contextTokens";

const STATE_FILE_VERSION = 1;
// The file holds the bot token and per-user context tokens.
const STATE_FILE_MODE = 0o600;

const persistedStateSchema = z.object({
  version: z.literal(STATE_FILE_VERSION),
  credentials: z
    .object({
      botToken: z.string().min(1),
      baseUrl: z.url(),
      botId: z.string().optional(),
      ownerId: z.string().optional(),
    })
    .optional(),
  cursor: z.string().optional(),
  contextTokens: z.record(z.string(), z.string()).optional(),
});

type PersistedState = z.infer<typeof persistedStateSchema>;

/** The provider's mutable state: login, inbound cursor, per-user context tokens. */
export interface WeChatState {
  contextToken(userId: string): string | undefined;
  credentials(): WeChatCredentials | undefined;
  /** The `getupdates` cursor; `""` before the first poll. */
  cursor(): string;
  /** Write the state file when one is configured and something changed. */
  save(): Promise<void>;
  setContextToken(userId: string, token: string): void;
  /** Switching to a different bot token drops the old bot's cursor and tokens. */
  setCredentials(credentials: WeChatCredentials): void;
  setCursor(cursor: string): void;
}

const isMissingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const readStateFile = async (
  file: string
): Promise<PersistedState | undefined> => {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`WeChat state file ${file} is not valid JSON.`, {
      cause: error,
    });
  }
  const parsed = persistedStateSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `WeChat state file ${file} has an unexpected shape: ${parsed.error.message}`
    );
  }
  return parsed.data;
};

// Write to a sibling temp file, then rename, so a crash never leaves a
// truncated state file behind.
const writeStateFile = async (
  file: string,
  state: PersistedState
): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
    mode: STATE_FILE_MODE,
  });
  await rename(temp, file);
};

const contextTokenMap = (store: Store): Map<string, string> => {
  const existing = store.get(CONTEXT_TOKENS_KEY);
  if (existing instanceof Map) {
    return existing as Map<string, string>;
  }
  const created = new Map<string, string>();
  store.set(CONTEXT_TOKENS_KEY, created);
  return created;
};

const seedStore = (store: Store, persisted: PersistedState): void => {
  if (persisted.credentials) {
    store.set(CREDENTIALS_KEY, persisted.credentials);
  }
  if (persisted.cursor) {
    store.set(CURSOR_KEY, persisted.cursor);
  }
  store.set(
    CONTEXT_TOKENS_KEY,
    new Map(Object.entries(persisted.contextTokens ?? {}))
  );
};

const snapshot = (store: Store): PersistedState => ({
  version: STATE_FILE_VERSION,
  credentials: store.object<WeChatCredentials>(CREDENTIALS_KEY),
  cursor: store.string(CURSOR_KEY),
  contextTokens: Object.fromEntries(contextTokenMap(store)),
});

/**
 * Open the provider state on Spectrum's `store`, first loading `file` when
 * given (a missing file is fine; a malformed one throws).
 */
export const openState = async (
  store: Store,
  file?: string
): Promise<WeChatState> => {
  const persisted = file ? await readStateFile(file) : undefined;
  if (persisted) {
    seedStore(store, persisted);
  }

  let dirty = false;
  let writes: Promise<void> = Promise.resolve();
  const credentials = () => store.object<WeChatCredentials>(CREDENTIALS_KEY);

  return {
    credentials,
    setCredentials(next) {
      const previous = credentials();
      if (previous && previous.botToken !== next.botToken) {
        store.delete(CURSOR_KEY);
        store.delete(CONTEXT_TOKENS_KEY);
      }
      store.set(CREDENTIALS_KEY, { ...next });
      dirty = true;
    },
    cursor: () => store.string(CURSOR_KEY) ?? "",
    setCursor(cursor) {
      if (cursor !== store.string(CURSOR_KEY)) {
        store.set(CURSOR_KEY, cursor);
        dirty = true;
      }
    },
    contextToken: (userId) => contextTokenMap(store).get(userId),
    setContextToken(userId, token) {
      const tokens = contextTokenMap(store);
      if (tokens.get(userId) !== token) {
        tokens.set(userId, token);
        dirty = true;
      }
    },
    save() {
      if (!(file && dirty)) {
        return writes;
      }
      dirty = false;
      const state = snapshot(store);
      writes = writes
        .catch(() => undefined)
        .then(() => writeStateFile(file, state))
        .catch((error: unknown) => {
          // Retry on the next save.
          dirty = true;
          throw error;
        });
      return writes;
    },
  };
};
