# Contributing to Mercury

Thanks for your interest in improving Mercury! This guide covers how to build, test and submit
changes.

## Prerequisites

- **Node.js ≥ 22.5** (Mercury uses the built-in `node:sqlite`). Check with `node -v`.
- npm (ships with Node).

## Getting started

```bash
git clone https://github.com/ms1963/mercury_agent.git mercury
cd mercury
npm install
npm run build      # tsc project references across all packages
npm test           # vitest, runs offline
```

Mercury is a monorepo of seven packages under `packages/` (`core`, `tools`, `mcp`, `gateway`,
`runtime`, `server`, `cli`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layout and
[docs/EXTENDING.md](docs/EXTENDING.md) for extension points (tools, providers, patterns, adapters,
plugins).

## Development workflow

1. **Fork** the repository and create a topic branch from `main`:
   ```bash
   git checkout -b feat/short-description
   ```
2. Make your change with the **smallest diff** that does the job. Match the surrounding code style;
   don't reformat untouched code.
3. Keep the build and tests green:
   ```bash
   npm run build
   npm test            # 185 tests across 15 files must pass
   npx eslint .
   ```
4. **Add or update tests** for any behavior you change. The suite runs offline against a
   deterministic mock provider (enabled only under `MERCURY_ENABLE_MOCK=1`, which the test harness
   sets automatically). Production code must never enable the mock outside tests.
5. Update docs when you change user-facing behavior (`README.md`, the relevant file under `docs/`,
   and `STATUS.md` if a subsystem's tested status changes).

## Commit messages

Use short, imperative, type-prefixed subjects — e.g. `feat: add X`, `fix: handle Y`, `docs: …`,
`test: …`, `refactor: …`, `chore: …`. Explain the *why* in the body when it isn't obvious.

## Pull requests

- Describe what changed and why; link any related issue.
- Confirm `npm run build`, `npm test` and `npx eslint .` all pass.
- Keep PRs focused — one logical change per PR.
- Note explicitly if anything was **not** tested against real external services (LLM APIs, chat
  platforms, STT/TTS). Mercury's docs are deliberately honest about tested-vs-untested status.

## Reporting bugs and requesting features

Open an issue describing the expected vs actual behavior, steps to reproduce, and your environment
(`node -v`, OS). For security issues, follow [SECURITY.md](SECURITY.md) instead of filing a public
issue.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to
uphold it.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
