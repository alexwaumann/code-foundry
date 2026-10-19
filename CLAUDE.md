# code-foundry

macOS desktop app (Go daemon + Wails v3/React GUI + CLI) for running fleets of Claude Code
threads across git worktrees. Read `docs/ARCHITECTURE.md` before changing structure and
`docs/PLAN.md` to see which step you are on.

## Commands

```
make gen      # buf generate (Go + TS). Generated code is committed.
make build    # builds ./bin/code-foundry
make check    # gofmt, go vet, staticcheck, go test ./..., frontend typecheck + lint + test
make gui-e2e  # Playwright (WebKit, 4 workers) against the mock daemon; not part of check
make dev      # daemon in foreground with text logs
make package VERSION=vX.Y.Z   # release assets in dist/ (tarball of the two executables + VERSION, install.sh)
make release  # manual release fallback (DRY_RUN=1 prints the commands); releases run on push to main
cd gui && wails3 dev   # GUI with hot reload (needs a running daemon or auto-starts one)
```

## Boundaries

- Stores (`internal/store/*`) own processes and publish snapshots. They never render and
  never import `internal/api` or anything under `gui/`.
- `internal/api` handlers are thin: read snapshot, subscribe to bus, forward intent.
- The frontend talks only to the daemon over Connect-Web. The Wails host is a window shell.
- Every user action is a command in `internal/command`. Palette, keybindings, and CLI verbs
  are generated from it. Do not add a user action anywhere else.
- Features add files, not edits. Registries over switch statements.

## Go

- Go 1.26 (the libghostty-vt bindings require it). `context.Context` first. Wrap errors with `%w`. No panics outside `main`.
- `log/slog` only. No `fmt.Println` in library code.
- cgo is touched only inside its owning goroutine: libghostty-vt in the terminal actor, FSEvents in the project store's stream goroutine (`internal/store/project/fsevents.go`).
- Table tests for anything with branches. Fakes live in `<pkg>/<pkg>test`.
- Proto changes: edit `proto/`, run `make gen`, commit generated code.

## Frontend

- TypeScript strict, React 19, Tailwind v4, shadcn/ui, Zustand, cmdk, @xterm/xterm.
- Generated protobuf types are used only in `src/api/`. Map to view models there.
- Narrow selectors. Virtualize lists. No component subscribes to a whole slice.
- One `ThreadService.WatchThread` stream per visible thread view (shared when two views show the same thread) and one `TerminalService.Attach` stream per visible terminal view; nothing off screen holds one.
- Text uses a type role class (`text-display`, `text-display-sm`, `text-title`, `text-heading`, `text-subheading`, `text-overline`, `text-body`, `text-body-sm`, `text-label`, `text-caption`, `text-caption-sm`, `text-link`, `text-code`; `text-brand` is the sidebar's app name only; the display roles are for a page's or panel's one big figure), with colour/weight utilities as modifiers after it; never a Tailwind size (`text-sm`, `text-[13px]`) or `leading-[…]` directly. A weight (`font-medium`) is fine as a modifier on a role. `cn` comes from `@/lib/utils`, which knows the roles.
- Radii use the scale (`rounded-sm` 4, `rounded-md` 6, `rounded-lg` 10, `rounded-pane` 12, `rounded-2xl` 16, `rounded-full`), never bare `rounded` or `rounded-[…]`; an inner corner is one step smaller than its padded parent's. `src/design/guards.test.ts` enforces both, strictly: no file under `src` may have a hit.

## Verification

Before claiming a step done: `make check` green, the new behavior exercised end to end
(daemon + CLI or daemon + GUI), and a short note in `docs/notes/<step>.md` recording
decisions and gotchas. Notes are text only: screenshots belong in the PR body (served
from a shots branch or the PR's commits), never under `docs/notes/`.

After the final commit is pushed, run `make attest`. It posts a `local-check` status on
the pushed commit if its tree is the one `make check` last passed on, and CI then skips
its jobs for that pull request. If it refuses (tree changed since the check), run
`make check` again and re-attest. Never attest a tree you did not check.
