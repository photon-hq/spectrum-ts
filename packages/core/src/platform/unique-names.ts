import type { PlatformProviderConfig } from "./types";

/**
 * Fail closed when two providers share a `definePlatform` name.
 *
 * `Spectrum()` stores runtimes in a map keyed by `def.name`. Without this
 * check, a later registration silently replaces an earlier one — the first
 * client may still have been constructed, but routing, narrowing, and
 * message subscription resolve against the overwritten entry.
 *
 * Call before any `createClient` work so a bad composition never leaves
 * half-initialized providers behind.
 */
export const assertUniquePlatformNames = (
  providers: readonly PlatformProviderConfig[]
): void => {
  const counts = new Map<string, number>();
  for (const provider of providers) {
    const name = provider.__definition.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => `"${name}" (${count}×)`);

  if (duplicates.length === 0) {
    return;
  }

  throw new Error(
    `Spectrum received duplicate platform name(s): ${duplicates.join(", ")}. ` +
      "Each definePlatform name must be unique within a single Spectrum() instance."
  );
};
