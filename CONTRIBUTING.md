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

Pull requests target `devs/main`, the development branch: it is always
ahead of `main` and carries the full test suite. `main` only receives
releases, merged from `devs/main` without the tests. Branch from
`devs/main`, then run:

```bash
npm ci
npm run typecheck   # tsc and vue-tsc
npm run lint        # ESLint
npm run build       # core, tool host and frontend
```

Then run the tests of the areas you touched: how to run each suite
(TypeScript, browser service, Python, PostgreSQL) is in
[docs/testing.md](docs/testing.md). The public CI (GitHub Actions) runs
the commands above on Node 24.

- Remaining Python (RAG, Office engine, `deploy/`): `venv/bin/ruff check .`.
- Formatting: `npm run format` (Prettier).
- After adding Tailwind utility classes:
  `node tools/generate_tailwind_css.mjs`.
- One pull request = one topic; describe the before/after behavior and what
  you tried by hand.
- No new dependency under a strong copyleft license (GPL/AGPL) in the
  core: it must stay optional (see `requirements-agpl-optional.txt`).
  Every shipped dependency is listed in `THIRD_PARTY_NOTICES.md`.
<!-- REUSE-IgnoreStart -->
- New source files: `SPDX-License-Identifier: MIT` header.
<!-- REUSE-IgnoreEnd -->
- Sign your commits (`git commit -s`): see "Developer Certificate of Origin" below.

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
