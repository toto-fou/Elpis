# Roadmap

The major upcoming steps, with no dates. Details move forward batch by batch in
pull requests; what is done, released or not, is in
[CHANGELOG.md](CHANGELOG.md).

## Done (unreleased)

- **Explicit tool contracts**: a single description of a tool's properties
  (read-only, write, network, serial execution).
- **Agent resident in the sandbox**: files and Git run inside the user's
  container; the host no longer touches its content.
- **Observability**: a trace of each turn, the "Run details" of a response,
  a runs view in the console.

## Next

- **Projects**: one workspace per repository, `AGENTS.md` as the project's memory.
- **Checkpoints and worktrees**: go back to an earlier state of a session,
  work on several branches in parallel.
- **`devcontainer.json`**: the sandbox environment described by the repository.
- **Policies and secrets**: rules for actions outside the sandbox, secret
  rotation.

## Later

- Collaboration between users (shared project, handover).

## Ongoing

- Splitting the largest modules, concurrency tests, wider typed scope.
