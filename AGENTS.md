# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun x ultracite fix` before committing to ensure compliance.

---

## Cursor Cloud specific instructions

This is a **Bun workspaces + Turbo monorepo** that publishes the `spectrum-ts` SDK and its provider packages. It is a **library, not a deployable service** — there are no servers, databases, or background daemons to run. The full validation loop is in-process. Standard commands live in `CONTRIBUTING.md` (`bun run check` / `typecheck` / `test` / `test:node` / `test:bun` / `build`) and `package.json` scripts; use those rather than reinventing them.

Runtime: Bun (pinned to `.bun-version`, currently 1.3.14) is the package manager. Tests use Vitest and run under BOTH runtimes — `bun run test:node` (Node 24) and `bun run test:bun` (`bun --bun vitest run`); `bun run test` runs both. Node 24 is also installed and made the default `node` (see build gotcha below).

Non-obvious gotchas:

- **Build/dev require Node ≥ 24.11.1, not the pre-installed Node 22.** The `tsdown` build tool runs via a `#!/usr/bin/env node` shebang, and its `auto` config loader only loads the `tsdown.config.ts` files natively on Node ≥ 24.11.1. On older Node it falls back to the optional `unrun` package (not installed) and the build fails with `Failed to import module "unrun"`. Node 24 is installed via nvm and prepended onto `PATH` in `~/.bashrc` ahead of the pre-installed `/exec-daemon` Node 22, so `bun run build` and `bun run dev` work as documented. If you ever see the `unrun` error, run `node --version` — it must report v24.x. (Alternatively `bun run --bun build` forces the bin under Bun and also works.)
- **`bun run dev` needs `--concurrency` ≥ 11.** There are 10 persistent watch tasks and Turbo's default concurrency is 10, so plain `bun run dev` aborts with `Invalid task configuration`. Run `bun run dev --concurrency=12`.
- **Example app (`bun run examples/basic/index.ts`)** uses the Terminal provider, which downloads a `tuichat` binary on first run (needs network the first time; set `TUICHAT_BINARY`/`TUICHAT_VERSION` to skip). In a non-TTY shell it runs in plain readline mode and reads inbound messages from stdin, so you can drive it by piping lines in; it reacts with 👀 and echoes each message back.
