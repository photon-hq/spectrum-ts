# Contributing to Spectrum

Thanks for your interest in contributing. This document covers how to set up your development environment, the expectations for contributions, and the workflow for getting changes merged.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). Please report unacceptable behavior to the maintainers.

## Ways to Contribute

- **Report bugs** by [opening an issue](https://github.com/photon-hq/spectrum-ts/issues). Search existing issues first to avoid duplicates.
- **Suggest features** through GitHub Discussions or an issue describing the use case.
- **Improve documentation** — typos, clarifications, and new examples are always welcome.
- **Submit pull requests** for bug fixes, new platform providers, or improvements.

## Prerequisites

- [Bun](https://bun.sh) 1.3.5 or later
- TypeScript 5 or later
- macOS (required for iMessage provider development)

## Development Setup

```bash
git clone https://github.com/photon-hq/spectrum-ts.git
cd spectrum-ts
bun install
```

### Build

```bash
bun run build
```

### Watch mode

```bash
bun run dev
```

### Run an example

```bash
bun run examples/basic/index.ts
```

### Lint and format

```bash
bun run check   # check for issues
bun run fix     # auto-fix
```

This project uses [Ultracite](https://ultracite.ai) (Biome) for formatting and linting. Run `bun run fix` before committing.

## Project Structure

```
packages/
  spectrum-ts/           # Core SDK
    src/
      providers/         # Platform providers (iMessage, WhatsApp, terminal)
      ...
examples/                # Example apps
```

## Pull Request Workflow

1. **Fork** the repository and create a feature branch from `main`.
2. **Make your changes.** Keep commits focused and descriptive.
3. **Run `bun run fix`** to format and lint.
4. **Run `bun run build`** to verify the build passes.
5. **Update documentation** if you're changing public APIs.
6. **Open a pull request** with a clear description of the problem and your solution. Link any related issues.

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new features
- `fix:` — bug fixes
- `docs:` — documentation changes
- `refactor:` — code changes that neither fix bugs nor add features
- `chore:` — tooling, dependencies, etc.

Example: `feat: add reply support to WhatsApp provider`

### Pull Request Guidelines

- Keep changes focused. One PR per logical change.
- Match the existing code style. Biome will enforce most of it.
- Prefer explicit types for public APIs.
- Don't introduce breaking changes to public APIs without discussion.
- Add or update examples when introducing new features.

## Adding a Platform Provider

New platform providers are welcome. See the [custom platform provider guide](https://docs.photon.codes) for the full API. At a minimum, a provider must implement:

- `config` — a Zod schema for user-supplied configuration
- `user.resolve` and `space.resolve`
- `lifecycle.createClient` and `lifecycle.destroyClient`
- `events.messages` — an async generator that yields incoming messages
- `actions.send`

Optional capabilities (typing indicators, reactions, threaded replies) should be implemented when the underlying platform supports them.

## Reporting Security Issues

Do not open public issues for security vulnerabilities. Email the maintainers at **security@photon.codes** and we will respond promptly.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
