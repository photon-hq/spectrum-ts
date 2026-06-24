# The provider manifest (`generate-manifest.ts`)

`scripts/generate-manifest.ts` (in the `spectrum-ts` package) emits
**`dist/manifest.json`** — a small, public description of every provider package
in the workspace. External tooling reads it so that **adding a provider package is
all you need to do**: downstream scaffolders like `create-spectrum-app` pick the
new provider up automatically, with no second list to keep in sync.

The generator's job is half code-gen, half guardrail. It derives each entry from
the provider's hand-written `package.json#spectrum` metadata, then **validates that
metadata against the provider's own source** so the published surface can't quietly
drift away from what the code actually exports.

## The artifact

Each entry is a `ManifestEntry`, sorted by `key`:

```json
[
  {
    "key": "imessage",
    "import": "imessage",
    "path": "@spectrum-ts/imessage",
    "label": "iMessage"
  },
  {
    "key": "telegram",
    "import": "telegram",
    "path": "@spectrum-ts/telegram",
    "label": "telegram"
  }
]
```

| Field | Source | Meaning |
|---|---|---|
| `key` | `package.json#spectrum.key` | Short, stable routing slug for the provider (lowercase). |
| `import` | `package.json#spectrum.import` | The named export consumers `import { … }` — must equal the `export const` name in `src/index.ts`. |
| `path` | the package's `name` field | The npm package a consumer adds to their dependencies and imports from. |
| `label` | `package.json#spectrum.label` | The platform name passed to `definePlatform(<label>, …)` — the platform identifier. |

> `key` and `label` are independent. For fusor providers they coincide (Telegram:
> `key` and `label` are both `"telegram"`, because the `definePlatform` name doubles
> as the routing key — see the [platform identifier invariant](./fusor.md)). For
> others they differ (iMessage: `key` `"imessage"`, `label` `"iMessage"`).

## When it runs

It's the last step of the `spectrum-ts` package's `build`:

```jsonc
// packages/spectrum-ts/package.json
"build": "tsdown && node ../../scripts/smoke-import.mjs dist/index.js && bun scripts/generate-manifest.ts"
```

You can also run it on its own:

```bash
cd packages/spectrum-ts
bun run generate:manifest   # → bun scripts/generate-manifest.ts
```

It performs **pure source reads** — it never touches any provider's build output,
only their `package.json` and `src/*.ts`. That's deliberate: it has no dependency
on provider `dist/`, so it can run early in the task graph without waiting on other
packages to build. `dist/manifest.json` is a build artifact (gitignored) and is
regenerated on every build.

## How it builds the manifest

`buildManifest()` walks every **sibling** directory of the `spectrum-ts` package
(i.e. all of `packages/*`) and decides, per directory, whether it's a provider:

1. **Read `package.json`.** No file, or unparseable → skip silently (not every
   directory is a package).
2. **Filter.** Skip unless the package has a `spectrum` field, is **not** `private`,
   and has a `name`. (This is why `@spectrum-ts/core`, the `spectrum-ts`
   meta-package, and the private `test-support` package are all absent — none carry
   a `spectrum` field.)
3. **Require complete metadata.** A `spectrum` field present but missing any of
   `key` / `import` / `label` is a hard error, not a skip.
4. **Validate against source** (see below).
5. **Emit** `{ key, import, path: pkg.name, label }`.

Finally it **sorts by `key`** (`localeCompare`) so the file diff is stable across
machines and filesystem orderings, ensures `dist/` exists (`mkdir … { recursive:
true }` — a no-op when tsup already made it), and writes pretty-printed JSON with a
trailing newline. If **no** provider packages were found at all, it throws rather
than writing an empty manifest.

## The guardrail: validating against source

This is the part that keeps the hand-written `spectrum` metadata honest.
`validateAgainstSource()` reads the provider's `src/index.ts` and matches it against:

```text
export const <import> = definePlatform(<label>, …)
```

via this regex (anchored per-line, so the export must be top-level):

```ts
/^export\s+const\s+(\w+)\s*=\s*definePlatform\(\s*(?:"([^"]+)"|(\w+))/m
```

It then cross-checks two things, throwing a precise error on any mismatch:

- **`import` ↔ exported name.** The `export const <name>` must equal
  `spectrum.import`.
- **`label` ↔ `definePlatform` name.** The first argument to `definePlatform` must
  equal `spectrum.label`.

The `definePlatform` name argument comes in **two shapes**, and the regex captures
both:

| Shape | Example | How `label` is resolved |
|---|---|---|
| String literal | `export const imessage = definePlatform("iMessage", { … })` | Taken inline from the matched `"…"`. |
| Shared const | `export const telegram = definePlatform(TELEGRAM_PLATFORM, { … })` | The matched identifier is resolved by `resolvePlatformLabel()`. |

Fusor providers use the shared-const shape on purpose: the platform name is the
single source of truth for the routing key, so it lives in one exported const
(`export const TELEGRAM_PLATFORM = "telegram"` in `src/config.ts`) that
`definePlatform`, `fusor()`, and event routing all reference. When the generator
sees an identifier instead of a literal, `resolvePlatformLabel()` scans the
provider's `src/*.ts` files for a matching `const <name> = "…"` (double-quoted) and
uses that string. If the const can't be found, it throws.

### The three places that must agree

For a provider to make it into the manifest, these must line up — the generator
fails the build otherwise. For Telegram (the shared-const shape):

```ts
// package.json#spectrum
{ "import": "telegram", "label": "telegram" }
//             │              │
//             │              └──────────────┐  must equal definePlatform's name…
//             └──────────────┐              │
// src/index.ts               ▼              ▼
export const telegram = definePlatform(TELEGRAM_PLATFORM, { … });
//           └─ must equal `import`         │  …resolved from:
// src/config.ts                            ▼
export const TELEGRAM_PLATFORM = "telegram";
```

## Failure modes

Every error names the offending package so the build log points straight at the fix.

| Thrown when | Message (abbreviated) |
|---|---|
| `spectrum` field is missing `key`, `import`, or `label` | `…#spectrum must define key, import, and label.` |
| `src/index.ts` has no matching `export const … = definePlatform(…)` | `…does not match the expected … pattern. If you intentionally renamed the call, update generate-manifest.ts.` |
| Exported name ≠ `spectrum.import` | `…spectrum.import is "X" but src/index.ts exports \`Y\`.` |
| Shared-const label can't be found in `src/*.ts` | `Provider source references platform-name constant "X" but no \`const X = "…"\` was found…` |
| Resolved label ≠ `spectrum.label` | `…spectrum.label is "X" but definePlatform uses "Y".` |
| No provider packages found at all | `No provider packages with a package.json#spectrum field found under …` |

## Adding a provider

Because the manifest is derived, you don't edit it. To have a new provider appear
in `manifest.json` (and thus in downstream scaffolders):

1. Give the package a **public** `package.json` (no `"private": true`) with a `name`.
2. Add a `spectrum` field:

   ```jsonc
   "spectrum": {
     "key": "myplatform",
     "import": "myplatform",
     "label": "MyPlatform"
   }
   ```

3. Export the platform from `src/index.ts` so it matches the contract:

   ```ts
   export const myplatform = definePlatform("MyPlatform", { /* … */ });
   ```

   (or use a shared `const MYPLATFORM_PLATFORM = "MyPlatform"` for the fusor shape.)

The next build picks it up. If anything is inconsistent, the build **fails loudly**
with one of the messages above rather than shipping a wrong manifest.

> If you intentionally change the `definePlatform` call shape (e.g. wrap it, or
> rename it), the validating regex in `generate-manifest.ts` must be updated to
> match — the error message for that case says so explicitly.

## Reference

- Generator — `packages/spectrum-ts/scripts/generate-manifest.ts`
- Output — `packages/spectrum-ts/dist/manifest.json` (gitignored build artifact)
- Build wiring — `packages/spectrum-ts/package.json` (`build`, `generate:manifest`)
- `definePlatform(name, def)` — `packages/core/src/platform/define.ts`
- Provider metadata — each provider's `package.json#spectrum` + `src/index.ts`
