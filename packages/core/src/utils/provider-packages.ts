// Official provider lookup for diagnostics. When an inbound event or a cloud
// project references a platform that has no registered provider, core can
// point at the exact package to install instead of a bare "no handler" —
// the per-provider packages are optional installs since v5, so this is the
// only place a user who forgot one gets told what's missing.
//
// Keep keys in sync with the provider packages' `package.json#spectrum.key`
// (generate-manifest.ts validates those against each provider's source).
// Lookup is tolerant of the three spellings that occur in the wild: the
// `definePlatform` label ("iMessage", "WhatsApp Business"), the fusor routing
// key ("telegram"), and the cloud platform key ("whatsapp_business").

const OFFICIAL_PROVIDER_PACKAGES: Readonly<Record<string, string>> = {
  imessage: "@spectrum-ts/imessage",
  slack: "@spectrum-ts/slack",
  telegram: "@spectrum-ts/telegram",
  terminal: "@spectrum-ts/terminal",
  "whatsapp-business": "@spectrum-ts/whatsapp-business",
};

const SEPARATORS = /[\s_]+/g;

export const normalizePlatformKey = (platform: string): string =>
  platform.trim().toLowerCase().replace(SEPARATORS, "-");

export const officialProviderPackage = (platform: string): string | undefined =>
  OFFICIAL_PROVIDER_PACKAGES[normalizePlatformKey(platform)];

// `bun add` when running under Bun, `npm install` otherwise — runtime
// detection is definitive, unlike npm_config_user_agent which is unset for
// plain `node server.js` / systemd / Docker processes.
const installCommand = (pkg: string): string =>
  process.versions.bun ? `bun add ${pkg}` : `npm install ${pkg}`;

/**
 * One-line install hint for a platform provided by an official package, or
 * undefined for unknown/custom platforms. Appended to "no handler" style
 * warnings — advisory only, callers must not change behavior based on it.
 */
export const officialProviderInstallHint = (
  platform: string
): string | undefined => {
  const pkg = officialProviderPackage(platform);
  if (!pkg) {
    return;
  }
  return `the "${platform}" platform is provided by the optional package ${pkg} — install it (\`${installCommand(pkg)}\`) and pass it to Spectrum({ platforms: [...] })`;
};
