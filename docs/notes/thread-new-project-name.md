# thread new --project takes a name (2026-10-18)

Both agents that built the skills (`agent-skills.md`) and the worktree recreation
(`recreate-worktree.md`) hit the same wall: `code-foundry thread new --project <name>`
failed with "thread not found: project <name>", although the guide promised "a project id
or name" and `thread list --project` accepted both. `CreateThreadRequest.project_id`
reached the thread store's `resolveWorktree` and `newWorktree`, which looked the value up
as an id only.

## Decision

Resolve in the daemon, not the CLI: both lookups go through `Manager.projectByRef`, which
is `workspace.ResolveProject` (id, else a unique name, else an absolute path inside a
worktree), the resolver `List` already used for the filter. One place, so the GUI, the
CLI and an agent's call all accept the same refs. A ref naming nothing stays NotFound
(`project <ref>`); several projects with the name is InvalidArgument naming the ids. The
arg description now reads "Project id or name". The orchestrate skill keeps passing ids
(`project list` prints them), which is unambiguous when two projects share a name.
