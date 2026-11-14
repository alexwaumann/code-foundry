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
make release  # manual release fallback (DRY_RUN=1 prints the commands); a tip is released after each green sweep on main
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
- Text uses a type role class (`text-display`, `text-display-sm`, `text-title`, `text-heading`, `text-subheading`, `text-overline`, `text-body`, `text-body-sm`, `text-label`, `text-caption`, `text-caption-sm`, `text-link`, `text-code`; `text-brand` is the top bar's app name only; the display roles are for a page's or panel's one big figure), with colour/weight utilities as modifiers after it; never a Tailwind size (`text-sm`, `text-[13px]`) or `leading-[…]` directly. A weight (`font-medium`) is fine as a modifier on a role. `cn` comes from `@/lib/utils`, which knows the roles.
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
decisions and gotchas. Notes are text only: screenshots belong in the PR body, never under
`docs/notes/`.

## Commits

The subject is `type(scope): summary`: lower case, no full stop, 72 characters at most; the
scope is the area (`gui`, `thread`, `plugin`, `api`, `pages`, ...) and may be left out. The
body says why. `make check` and `make attest` refuse a branch with any other subject
(`scripts/check-commits.sh`), because the release version is read from the subjects:

- `feat`: something a user, plugin author or agent can now do that they could not: a new
  verb, setting, panel, page ability or SDK API. The next release is a minor.
- `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`: everything
  else, including a change to how an existing thing looks or behaves. A patch.
- `!` before the colon (`refactor(api)!: ...`) marks a breaking change: a removed or renamed
  verb, RPC, setting or SDK API. A minor while the version is 0.x; 1.0.0 is only ever
  released by name.

## Pull requests

Every change lands as a pull request, and the pull request is the record of it: what
changed, why, and for a UI change what the app looks like before and after.

- Order: edit, `make check`, commit, push, `make attest`, `gh pr create`. `make attest`
  posts a `local-check` status on the pushed commit if its tree is the one `make check`
  last passed on. That status is the pull request's only check (`attested`): green with it,
  red without it, and the suite does not run on a pull request. If `make attest` refuses
  (the tree changed since the check), run `make check` again and re-attest; a PR opened
  before `make attest` has its red check re-run by it. Never attest a tree you did not check.
- One `make check` runs at a time on the machine; yours waits its turn behind other
  worktrees'. Do not go around the lock or loop on re-runs: fix what you touched, and
  re-run an unrelated timing failure once, naming it.
- Screenshots go in the body with `gh pr create --attach <file>` (or `gh pr edit --attach`),
  dark and light, before and after for a UI change. No shots branches.
- A UI change is compared with what was agreed before it was built. It must match on
  intent, not pixel for pixel. Every difference from what was agreed is listed in the body
  with its reason, and repeated in the thread.
- Workers open pull requests; the lead merges. A lead is the agent that aligned with the
  user (an agent working alone with the user is its own lead). A worker is an agent another
  agent started: it opens its PR, reports the URL, and never merges. The lead reads the
  diff, asks the worker for follow-ups, and merges.
- The lead merges when the PR is ready, without asking: `attested` green, the diff read,
  screenshots matching the agreed intent. Merging is the default; "don't merge yet" or
  "stack these and wait" from the user turns it off for that work. Ask first only for an
  on-disk migration, or a result that departs from the agreed intent in a way you cannot
  justify.
- Merge with `gh pr merge --merge` and the default subject. Rebase a branch onto main;
  never merge main into it.

## After the merge

Each push to main gets a sweep: the full suite on the merged tree, one run at a time, each
covering every merge since the last. A green sweep publishes the tip release from that
commit; a red one publishes nothing, so main stays red and tips stop until it is fixed.
A red sweep opens (or comments on) the one issue labelled `main-red`, with the failing
tests and the pull requests merged since the last green sweep; the next green sweep closes it.
Fix forward, fast: a red sweep is first checked for a timing flake (fix the test so it
waits for or controls what it raced, `docs/notes/flaky-ci-tests.md`; never a longer
timeout, a sleep, a retry or a skip), then for a real break. `make promote` tags the
newest sweep-green commit, not the head of main. Details: `docs/notes/ci-rethink.md`.
