import type { PlatformProviderConfig } from "./types";

export const assertUniquePlatformNames = (
  providers: readonly PlatformProviderConfig[]
): void => {
  const names = new Set<string>();

  for (const provider of providers) {
    const name = provider.__definition.name;
    if (names.has(name)) {
      throw new Error(
        `Spectrum received multiple providers for platform "${name}". Register exactly one provider per platform.`
      );
    }
    names.add(name);
  }
};
