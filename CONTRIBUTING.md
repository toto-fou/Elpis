# Contributing to Elpis

Contributions are welcome — issues and pull requests may be written in French
or English.

## Getting started

```bash
./install.sh    # guided: installs, configures and starts
npm ci          # Node ≥ 24 (.nvmrc): TypeScript development tools
```

- Code map: [ARCHITECTURE.md](ARCHITECTURE.md) (details:
  [docs/architecture.md](docs/architecture.md)).
- Conventions, commands and pitfalls: [AGENTS.md](AGENTS.md) — written for
  coding agents, valid for everyone.
- Interface: [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).

## Where things go

| I am changing… | Folder |
|---|---|
| an HTTP route of the core | its family in `apps/core/src/familles/` (mounting: `apps/core/src/familles.ts`); tool host routes: `apps/toolhost/src/` |
| the agent loop | `apps/core/src/boucle/` (orchestrator, LLM turn, tool execution) |
| the flow of a chat turn | `apps/core/src/familles/chat.ts`, `chat-controle.ts` and `apps/core/src/tour/` (admission, execution, recording, NDJSON) |
| the context, the scheduling | `apps/core/src/contexte/`, `apps/core/src/llm/ordonnanceur/` |
| an agent tool | native family: `apps/toolhost/src/mcp/` (+ `packages/outils-mcp`); Office family: `apps/toolhost/src/mcp/office/` (host, files and conversions) and the Python engine `office/elpis_office/` |
| an operation on a sandbox's files | host side: `packages/bac`, `packages/fichiers`, `apps/toolhost/src/fichiers/`; inside the container: the agent `sandbox-agent/server.py` (`/v1` API); never direct host access |
| a sandbox's Git | `packages/fichiers/src/git.ts` (through the agent), `relais-git.ts` (network), routes `apps/toolhost/src/git/` |
| the database | `packages/db/` (schema, migrations, dialects) |
| the interface | `frontend/src/`: `features/<domain>/` (TS logic), `components/<domain>/` (Vue SFCs), `entries/` (entry points), `app/racine/`; styles `frontend/css/`, images `frontend/assets/` |
| installation, launch | `install.sh`, `elpis`, `deploy/` |
| the operations documentation | `docs/operations.md`, `docs/configuration.md` |

Package details: [ARCHITECTURE.md](ARCHITECTURE.md); conventions and
pitfalls: [AGENTS.md](AGENTS.md).

## Before opening a pull request

Pull requests target `main` and must pass its CI. The tests live on
`devs/main`, the development branch: always ahead of `main`, it carries the
work in progress and the full test suite, and is where changes are
integrated and tested first. Pull requests to `main` do not include the
tests. Before opening one, run:

```bash
npm ci
npm ci --prefix browser-service   # the browser service's own dependencies
npm run typecheck   # tsc and vue-tsc
npm run lint        # ESLint
npm run build       # core, tool host, browser service and frontend
```

Then run the tests of the areas you touched: how to run each suite
(TypeScript, browser service, Python, PostgreSQL) is in
[docs/testing.md](docs/testing.md). The public CI (GitHub Actions) runs
the commands above on Node 24.

- Remaining Python (RAG, Office engine, `deploy/`): `venv/bin/ruff check .`.
- Formatting: `npm run format` (Prettier).
- After adding Tailwind utility classes:
  `node tools/generate_tailwind_css.mts`.
- One pull request = one topic; describe the before/after behavior and what
  you tried by hand.
- No new dependency under a strong copyleft license (GPL/AGPL) in the
  core: it must stay optional (see `requirements-agpl-optional.txt`).
  Every shipped dependency is listed in `THIRD_PARTY_NOTICES.md`.
<!-- REUSE-IgnoreStart -->
- New source files: `SPDX-License-Identifier: MIT` header.
<!-- REUSE-IgnoreEnd -->
- Describe the change under `## Unreleased` in `CHANGELOG.md`; never change the
  version (see "Versions and releases" below).
- Sign your commits (`git commit -s`): see "Developer Certificate of Origin" below.

## Versions and releases

Elpis has one version for the whole product. The root `package.json` carries
it, and `npm run bump` copies it everywhere else: workspace packages and their
`@elpis/*` pins, lockfiles, `pyproject.toml`, the browser service, the RAG
extractor, the desktop agent and the interface defaults.

- **Pull requests never change the version.** They add their entry under
  `## Unreleased` in `CHANGELOG.md`.
- **A release groups merged work.** A patch release batches fixes; it is not
  cut for each pull request.
- Versions are `X.Y.Z`, with no pre-release suffix. A version exists once its
  tag `vX.Y.Z` is pushed, and only the maintainer tags.
- Until 1.0.0:
  - `0.Y.0` (minor): new features, removals, or anything an administrator must
    act on: a database migration, a renamed or removed setting, a new
    prerequisite (sandbox image, Chromium, Node), an API or file format change
    (`mcp.json`, REST contracts).
  - `0.Y.Z` (patch): fixes and dependency updates, security ones included, that
    ask nothing of the administrator.
- 1.0.0 is the first stable release, and the maintainer alone decides when it
  comes. From then on, standard SemVer: a major version for any breaking change
  for administrators or integrations.
- Kept apart, with their own numbering: the sandbox image tag (a new tag
  whenever its sources change), database migrations, the Office engine channel
  protocol and the `mcp.json` schema.

Cutting a release:

```bash
npm run bump -- 0.1.5    # versions everywhere; "## Unreleased" becomes "## 0.1.5 — <date>"
npm run bump -- --check  # every location agrees (also run by the CI)
```

1. Open a "Release X.Y.Z" pull request with that change.
2. Test that commit on a staging instance: there are no release-candidate tags.
3. Merge, tag the merge commit (`git tag vX.Y.Z && git push origin vX.Y.Z`) and
   publish the GitHub release from its `CHANGELOG.md` section.

`npm run bump` refuses a version that is not newer, and 1.0.0 or above without
`--stable`.

## Developer Certificate of Origin (DCO)

Every commit carries a `Signed-off-by: First Last <Git identity>` line,
added by `git commit -s`. It attests to the
[Developer Certificate of Origin 1.1](https://developercertificate.org): you
wrote the contribution, or you have the right to publish it under the
project's MIT license. No CLA. If you forgot: `git commit --amend -s` (last commit) or
`git rebase --signoff` (several). The sign-off is not yet checked in CI.

The DCO text is authoritative in English; it is not copied here.

## AI-assisted code

You may use a coding assistant (Claude Code, Copilot, etc.), under
these conditions:

- You remain the **author** and the **person responsible** for the contribution: the
  sign-off (DCO) is yours, never the tool's.
- You **read and understand** every proposed line, and you have tried it
  yourself; a pull request that its author cannot explain is rejected.
- You **guarantee the rights** to the result: no generated code that
  reproduces third-party code under a license incompatible with the MIT license
  (copyleft, unknown license, source without a license), no text or image
  copied from a protected work, no secret or personal data in the
  prompts.
- State it in the pull request description when a significant part was
  generated (tool name, extent); a `Co-Authored-By` trailer in the commit
  message is welcome.
- The same rules apply to images, icons and texts.

## Code of conduct

Participation in the project assumes respect for the
[code of conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).

## License

By contributing, you agree that your contribution is distributed under the
MIT license (see [LICENSE](LICENSE)).
