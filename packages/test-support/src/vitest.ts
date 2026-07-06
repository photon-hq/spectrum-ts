import path from "node:path";
import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config";

const packagesDir = path.resolve(import.meta.dirname, "../..");

const packageSrcAlias = /^@\//;

// Bun resolves workspace packages to raw TS via the "bun" exports condition;
// Vite's resolver would pick the "default" condition and test stale dist/
// bundles instead. Alias every workspace specifier straight to source —
// aliased paths live outside node_modules, so Vitest transforms them.
const workspaceAliases = [
  {
    find: /^@spectrum-ts\/core\/authoring$/,
    replacement: path.join(packagesDir, "core/src/authoring.ts"),
  },
  {
    find: /^@spectrum-ts\/test-support\/(.*)$/,
    replacement: path.join(packagesDir, "test-support/src/$1.ts"),
  },
  {
    find: /^@spectrum-ts\/([a-z-]+)$/,
    replacement: path.join(packagesDir, "$1/src/index.ts"),
  },
  {
    find: /^spectrum-ts$/,
    replacement: path.join(packagesDir, "spectrum-ts/src/index.ts"),
  },
];

export const spectrumTestConfig = (
  packageDir: string,
  overrides: ViteUserConfig = {}
): ViteUserConfig =>
  mergeConfig(
    defineConfig({
      resolve: {
        alias: [
          ...workspaceAliases,
          {
            find: packageSrcAlias,
            replacement: `${path.join(packageDir, "src")}/`,
          },
        ],
      },
      test: {
        include: ["test/**/*.test.ts"],
      },
    }),
    overrides
  );
