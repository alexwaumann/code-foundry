# Adding projects: remove repo.register

Status: done on branch `t3code/remove-old-add-project-local-command`. `make check`,
`make gui-e2e` and `make gui-build` green; exercised against a scratch daemon (below).

`repo.register` ("Add Project (local folder)", a palette path prompt) duplicated the Add
Project dialog's Local folder tab. It is gone. `repo.add` ("Add Project") is the one
command for adding a project: in the app it opens the dialog, on the CLI
`code-foundry repo add <folder>` registers a folder.

## What changed

| Where | Change |
|---|---|
| `internal/command/commands_repo.go` | `repo.register` deleted. `RepoBackend.Register` stays (repo.add uses it). |
| `internal/command/commands_repo_add.go` | `repo.add` takes an optional positional `path` (Type Path): with one it calls `RepoBackend.Register` and answers `registered <name> (<id>)` with the repo as JSON; without one it prints `AddProjectHint`, which now names `code-foundry repo add <folder>`. `RegisterRepoAdd(r, repos, clone)` takes the backend (nil: Unimplemented). |
| `internal/command/all/all.go` | Passes `d.Repo` to `RegisterRepoAdd`. |
| `internal/api/repo.go` | `RepoService.Register` expands `~` and requires an absolute path (`command.ExpandPath`; failures are InvalidArgument), because the dialog now sends what the user typed straight to the RPC. The empty path still reaches the store, which refuses it. |
| `commands_prsession.go`, `store/workspace/resolve.go`, mock `world.ts` | Error hints that said `repo register` now say `repo add <folder>`. |
| `proto/.../command.proto` | The `name` field's example is `repo.add` (`make gen`: only that comment changed). |
| `gui/frontend/src/api/addProject.ts` | `registerRepo(path)`: `RepoService.Register` over Connect-Web, mapped to `AddedProjectView { id, name }`. |
| `gui/frontend/src/stores/addProject.ts` | `registerFolder` (Local folder tab, the GitHub tab's "Add existing folder") calls `registerRepo`: trailing slash trimmed, the daemon's ConnectError rejects as is (the tab shows `rawMessage` in place, no toast), `refreshCommands()` still runs afterwards. |
| `gui/frontend/src/components/start/StartPage.tsx` | Onboarding's "Add a project" is `repo.add`: it opens the dialog (on New, since there are no projects). |
| `gui/frontend/mock/server.ts`, `world.ts`, `filesystem.ts`, `clone.ts` | The mock implements `RepoService.Register` (`world.registerFolder`) with the daemon's rules: `~` expansion, absolute only, home boundary, the nearest enclosing git repository else the folder as a project without git, a folder that is not on the fake disk refused, an already registered project (or a folder inside one) returned unchanged. Existing clone destinations count as git folders. `repo.register` is gone from the mock registry; `repo.add` takes the optional path. |
| e2e | `start.spec.ts`: onboarding opens the dialog. `addproject.spec.ts`: no "Add Project (local folder)" in the palette; Local folder and Add existing folder assert on `RepoService.List` (new `listRepos` / `repoAt` fixtures) instead of command invocations; a new spec covers a plain folder (no git), a missing folder, and a folder inside a registered repo. `paths.spec.ts`: completion is driven through the Local folder tab. |
| Go tests | `commands_test.go` (names, When, invoke table), `commands_repo_add_test.go` (path registers with `~` expanded, no path is the hint, relative and `~user` are ErrInvalidArgs, backend errors pass through, nil backends are Unimplemented), `api/repo_test.go` (Register expands `~`), `api/command_test.go` (the fake is `fake.register`), CLI e2e (`workspace new` is the missing-required-arg case; `repo add` hint, relative folder against the working directory). |

## Decisions

* **The dialog calls the RPC, not a command.** It already streamed `RepoService.Clone`
  directly; Register is the same kind of call. Generated types stay in `src/api/`.
* **`~` expansion moved into the RPC handler** rather than the frontend (which does not
  know home) or the store (whose callers pass absolute paths already). Relative paths
  are refused there: a daemon cwd means nothing to a GUI caller. The CLI is unaffected:
  it makes Path args absolute against the caller's working directory before invoking,
  so `code-foundry repo add .` works.
* **The palette never prompts for repo.add's path.** `promptedArgs` only asks for
  required args and enums, and picking a command with nothing to ask runs its presenter
  (the dialog). Buttons and chords go through `startCommand`, which runs presenters
  first. Nothing else is generated from the registry that needed regenerating (CLI verbs
  and help come from `CommandService.List` at run time).
* **Palette path prompts stay** (`CommandPalette.tsx`, `pathCompletion.tsx`): other
  commands have Path args. No mock command prompts for a required path now, so the e2e
  path-completion specs drive the same completion through the Local folder tab.
* **Historical notes are annotated, not rewritten**: each note that mentions the old
  command has a one-line "Superseded" banner under its title.

## Verification

* `make check` green; `make gui-e2e` 350 passed, 4 skipped (the opt-in linkedprs
  screenshot specs) on WebKit and Chromium; `make gui-build` green.
* Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-rr-home`, `bin/code-foundry daemon --dev`):

```
$ code-foundry repo add
Add a project from the CLI with `code-foundry repo add <folder>` or `code-foundry repo clone <owner/repo>`; in the app, repo.add opens the Add Project dialog.
$ code-foundry repo add ~/projects/code-foundry
registered code-foundry (b1080fe9fff5)
$ code-foundry repo add ~/projects/code-foundry/internal --json   # the same repo
{"id":"b1080fe9fff5", "path":"/Users/alex/projects/code-foundry", ...}
$ code-foundry repo add ~/cf-rr-scratch/plain-notes/
registered plain-notes (4dae29bb7caa)
$ code-foundry repo add /tmp
code-foundry repo.add: invalid argument: /tmp is outside your home directory      (exit 2)
$ code-foundry repo register --path ~/cf-rr-scratch/plain-notes
code-foundry: unknown command "repo register" (run `code-foundry commands` to list commands)   (exit 2)
$ curl .../codefoundry.v1.RepoService/Register -d '{"path":"~/cf-rr-scratch/rpc-folder"}'
{"repo":{"id":"cc6346fa8bf7", "path":"/Users/alex/cf-rr-scratch/rpc-folder", ...}}
$ curl ... -d '{"path":"rel"}'     -> invalid_argument: want an absolute path, got "rel"
$ curl ... -d '{"path":"~bob/x"}'  -> invalid_argument: ~user paths are not supported
```

## Gotchas

* `grep "repo register"` also matches "repo registered" (a log line in
  `internal/store/repo/store.go`, `docs/perf.md`, `docs/notes/phase3-integration.md`).
  Those are not the command.
* protojson omits `git: false`, so the e2e `listRepos` fixture defaults a missing `git`
  to false.
