# @grml/lib-template

An ESM-friendly TypeScript library template, set up for testing and CI.

> Publishing and deployment are handled manually (custom npm settings), so no
> release/publish workflow is included here.

## What's inside

- **ESM-native**: `"type": "module"`, `nodenext` module resolution,
  `verbatimModuleSyntax`, and a thin `index.ts` barrel that re-exports from
  `src/` using `.js` specifiers.
- **TypeScript**: strict `tsconfig.json` emitting JS to `dist/` and `.d.ts`
  (plus declaration maps) to `dist/types/`.
- **Testing**: Node's built-in test runner (`node:test` / `node:assert`) run
  directly against TypeScript via [`tsx`](https://tsx.is). No extra framework,
  no compile step, and nothing test-related ends up in `dist/`.
- **Linting**: flat ESLint config built on `@eslint/js` and `typescript-eslint`
  recommended sets, plus the project rules (tabs, double quotes, `no-console`,
  ignore-pattern-aware unused checks, return-type hints).
- **API docs**: [TypeDoc](https://typedoc.org) generates HTML docs from your
  TSDoc comments into `docs/` (`npm run docs`).
- **Conventional Commits**: `commitlint` enforces the
  [Conventional Commits](https://www.conventionalcommits.org) format, and
  [git-cliff](https://git-cliff.org) turns that history into a `CHANGELOG.md`
  (`npm run changelog`).
- **Git hooks**: [lefthook](https://lefthook.dev) runs ESLint on staged files
  before commit and lints the commit message, installed automatically via the
  `prepare` script.
- **CI**: `.github/workflows/ci.yml` runs lint, typecheck, test, and build
  across Linux/macOS/Windows on Node 22 and 24, builds the docs, and uploads
  the `dist/` artifact.
- **Editor config**: `.vscode/` recommends the ESLint + Todo Tree extensions
  and wires up format-on-save via ESLint.
- **Node version**: `.nvmrc` pins Node 22 (`nvm use`).
- **Dependabot**: daily npm + GitHub Actions update PRs.

## Getting started

1. Copy this directory, run `git init` (if needed), then `npm install`, which
   also installs the git hooks via the `prepare` script.
2. Update `package.json` (`name`, `description`, `repository`, `keywords`).
3. Replace `src/greet.ts` with your implementation and update the re-exports in
   `index.ts`.
4. Add tests under `tests/` as `*.test.ts`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` + `index.ts` to `dist/` with type declarations. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run lint` | Run ESLint. |
| `npm run lint:fix` | Run ESLint and auto-fix what it can. |
| `npm test` | Run the test suite with the Node test runner via `tsx`. |
| `npm run docs` | Generate HTML API docs into `docs/` with TypeDoc. |
| `npm run changelog` | Regenerate `CHANGELOG.md` from the commit history with git-cliff. |

## Conventional commits & git hooks

Commits follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `chore:`, etc.). On `npm install`, the `prepare` script
installs [lefthook](https://lefthook.dev) git hooks. This requires a git
repository, so run `git init` first if you copied the directory.

- **pre-commit**: runs ESLint on staged JS/TS files.
- **commit-msg**: validates the message with `commitlint`.

Because the history is conventional, `npm run changelog` can regenerate
`CHANGELOG.md` automatically.

## Project layout

```
.
├── index.ts                # public barrel, re-export your API here
├── src/                    # implementation
│   └── greet.ts
├── tests/                  # *.test.ts, run with node --test via tsx
│   ├── greet.test.ts
│   └── tsconfig.json       # type-checks tests against the source
├── eslint.config.mjs
├── tsconfig.json
├── typedoc.json            # TypeDoc config (npm run docs)
├── commitlint.config.js    # Conventional Commits rules
├── cliff.toml              # git-cliff changelog config
├── lefthook.yml            # git hooks (lint + commitlint)
├── release.sh              # version bump + changelog + annotated tag
├── .nvmrc                  # pinned Node version
├── .vscode/                # recommended extensions + editor settings
└── .github/
    ├── ISSUE_TEMPLATE/     # bug report + feature request
    ├── workflows/ci.yml
    └── dependabot.yml
```

## Publishing (manual)

Only `dist/` is published (`"files": ["dist"]` in `package.json`, with
`.npmignore` as a backstop). Build first, then publish with your custom npm
settings:

```sh
npm run build
npm publish   # with whatever registry/auth settings you use
```

To cut a release first, `./release.sh v[X.Y.Z]` bumps the version in
`package.json`, regenerates `CHANGELOG.md`, commits, and creates an annotated
tag. Then `git push && git push --tags` and publish as above.
