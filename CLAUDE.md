# code-foundry

macOS desktop app (Go daemon + Wails v3/React GUI + CLI) for running fleets of Claude Code
threads across git worktrees. Read `docs/ARCHITECTURE.md` before changing structure; earlier
decisions are in `docs/notes/` and git history.

This codebase is yours: what it's for and how it's built are your call, and you'll keep
building on it.

## Commands

```
make gen      # buf generate (Go + TS). Generated code is committed.
make build    # builds ./bin/code-foundry and ./bin/code-foundry-dictate
make check    # gofmt, go vet, staticcheck, go test ./..., frontend typecheck + lint + test
make gui-e2e  # Playwright (WebKit, 4 workers) against the mock daemon; not part of check
make drive    # mock daemon + Vite for an agent to drive with `playwright cli` (DAEMON=dev: scratch dev daemon); skill .claude/skills/drive-app
make dev      # daemon in foreground with text logs; the browser dev frontend on :9245 may call it (CODE_FOUNDRY_DEV_ORIGINS for other ports)
make package VERSION=vX.Y.Z   # release assets in dist/ (tarball of the three executables + VERSION, install.sh, checksums.txt)
make release  # manual release fallback (DRY_RUN=1 prints the commands); releases run on push to main
make gui-build  # builds the GUI, gui/bin/Code Foundry, which `code-foundry gui` launches from ./bin
make gui-dev    # make build, then the GUI with hot reload (auto-starts the daemon if needed)
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
- Never a tooltip that repeats what is already on screen. A tooltip only shows what is hidden: an icon-only control's name, extra information that is not visible, or text that is cut off (`Tip whenTruncated`).
- Radii use the scale (`rounded-sm` 4, `rounded-md` 6, `rounded-lg` 10, `rounded-pane` 12, `rounded-2xl` 16, `rounded-full`), never bare `rounded` or `rounded-[…]`; an inner corner is one step smaller than its padded parent's. `src/design/guards.test.ts` enforces both, strictly: no file under `src` may have a hit.

## Tests: vitest first, e2e only for the browser

- If a vitest test (jsdom + RTL, or a pure function) can verify it, write a vitest test and no
  Playwright e2e test. This covers formatting, ordering, state transitions, conditional
  rendering, which command runs with which args, confirm flows, and menu contents.
- An e2e test is for what only a real browser or the whole app shows: geometry, scroll, resize,
  pointer drags, focus moving between regions, global chords through the keymap, iframes and the
  bridge, xterm, real ProseMirror editing (caret, undo, paste, tag atoms), computed theme CSS,
  stream counts, and a flow across routes and the daemon's streams.
- A test mixing both is split: the logic goes in vitest and a short e2e test keeps only the
  browser part. Never repeat in e2e an assertion a unit test already makes.
- What trips up a component test (jsdom, Radix, TanStack Virtual, dnd-kit, cmdk, vitest mocks):
  `docs/notes/testing-gotchas.md`.
- Daemon rules (refusals, git detection) are tested in Go, not through the mock.
- Playwright browsers (e2e, sketches, `playwright cli`) load localhost only: the mock, Vite, a
  `--dev` daemon. Never browse the public web with them; their builds lag security fixes. WebKit
  is the only engine installed (`bunx --cwd gui/frontend playwright install webkit`); never install
  Chromium.

## Verification

Before claiming a step done: `make check` green, the new behavior exercised end to end
(daemon + CLI or daemon + GUI), and a short note in `docs/notes/<step>.md` recording
decisions and gotchas. Notes are text only: screenshots belong in the PR body (served
from a shots branch or the PR's commits), never under `docs/notes/`.

After the final commit is pushed, run `make attest`. It posts a `local-check` status on
the pushed commit if its tree is the one `make check` last passed on, and CI then skips
its jobs for that pull request (a run that already started is cancelled and re-run). If it refuses (tree changed since the check), run
`make check` again and re-attest. Never attest a tree you did not check.
