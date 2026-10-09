# New thread composer

Decided 2026-10-09 (Alex). Built with three Opus 5.5 (high) agents on disjoint packages
after the proto contract was committed first; integrated and verified end to end against a
scratch daemon on haiku.

## What changed

* **Cmd+N (and every New Thread button, and `session.new` in the palette) opens a project
  picker** in the palette, then an in-pane **composer**: prompt, image attachments, model,
  effort, permission mode (Supervised / Accept edits / Auto, default Auto), worktree mode
  (New worktree / an existing worktree / Current checkout) and, for a new worktree, the
  base ref (default `origin/<default branch>`). Full access (`bypassPermissions`) is never
  offered. The picker always shows, even with a repo selected; the sidebar "+" on a
  worktree row skips it because it already names the worktree.
* **One command.** The composer stages images with `SessionService.StageAttachment`, then
  invokes `session.new` with `repo`, `worktree`, `model`, `effort`, `permission`,
  `new-worktree`, `base`, `prompt`, `attachments`. The CLI has the same flags.
* **Daemon `Create` is synchronous through worktree creation** so a failure (bad base,
  fetch error, git refusing) returns an error and the composer keeps the draft. Order:
  slug → `git fetch` of the base (bounded, non-fatal) → `git worktree add` → pre-trust →
  spawn.
* **The thread name never blocks.** Rows show the session id until the haiku namer
  returns. Only "new worktree" waits on the slug, bounded by `Options.SlugTimeout` (6s):
  branch `cf/<slug>`, else `cf/<session id>`. The same haiku call names the thread; it is
  never made twice. One retry on a 429-looking failure. Existing-worktree and
  current-checkout threads start immediately.
* **The first prompt is claude's positional argument** (`claude … -- "<prompt>"`). The
  PTY-typing path (`promptReady`, timers) is gone. `--` is required: `claude "-x"` is
  parsed as a flag.
* **`--permission-mode manual|acceptEdits|auto`** from `PermissionMode`; persisted
  (migration 0006) and re-passed on reconnect and fork.
* **Attachments**: PNG/JPEG/GIF/WebP, 10 MiB each, sniffed content; stored as
  `$CONFIG/attachments/<32 hex><ext>` (0600 in 0700); `Create` accepts only regular files
  directly in that directory; files older than 24h are reaped at daemon start. The prompt
  gets `Attached image: <path>` lines and every spawn passes `--add-dir <attachments
  dir>` so Claude reads them without a permission prompt (verified: Claude reads image
  paths named in the prompt with its Read tool; without `--add-dir`, auto mode stopped at
  "Allow this read outside the working directories?").
* **Defaults** `sessions.default_model = "opus"`, `sessions.default_effort = "high"`.
  "Claude's default" (empty) is no longer reachable from settings because an empty update
  means "reset to default".
* **`RepoService.ListRefs`** (local branches, then `<remote>/<branch>`, `origin/HEAD`
  dropped; `default_ref`). `CreateWorktreeRequest.fetch` fetches
  `+refs/heads/<b>:refs/remotes/<r>/<b> --no-tags` first (20s bound, warn and continue
  on failure). `repo.worktree.new` gained `--fetch` (default true).
* **Copy only**: "session" → "thread" in command titles, descriptions, messages, the
  palette category, and the GUI. Identifiers (`session.*`, `SessionService`, settings
  keys, store names) are unchanged; a full rename is a separate later pass.

## Gotchas

* `repos.worktree_dir` is applied by a wrapper in `internal/daemon/settings.go`, not in
  the repo store. The session store receives a path function from the daemon so
  session-created worktrees honor it; there is a test.
* Branch names are kept unique: `cf/<slug>` taken locally or on origin → `-2`…`-9`, then
  `cf/<id>`.
* The terminal store logs the full argv, prompt included; the session store logs only
  the prompt size.
* If claude fails to start after the worktree was created, the worktree stays on disk.
* WebKit on macOS skips buttons on Tab unless "Keyboard navigation" is on, so the composer
  handles Tab/Shift+Tab itself (textarea → model, effort, permission, attach → worktree,
  base → send).
* `session.new` is treated as startable in the GUI even when the daemon lists it as
  unavailable (no context): the picker supplies the repo.
* Auto mode: with a fresh Claude config an informational "Auto mode lets Claude handle
  permission prompts…" message appears but the input stays live, so no dialog handling
  was needed. Not reproduced on a brand-new account.
* The mock daemon's `session.new` is async (700 ms for a new worktree), names threads
  after 1–2 s, and fails on prompts containing `FAIL`.

## Verified

* `make check` green; Playwright 132/132 (WebKit + Chromium) against the mock.
* Real run: scratch daemon (`CODE_FOUNDRY_HOME=/tmp/…`), dev frontend via
  `?daemon=&token=`, Cmd+N → ⌘1 → prompt → Enter. Worktree
  `cf/fix-readme-scrach-typo` from `origin/main`, argv
  `claude --session-id … --model haiku --effort high --permission-mode auto --add-dir …
  -- <prompt>`, name applied in the background, Claude fixed the typo and committed.
* CLI: `session new --new-worktree` with an attachment (Claude described the image), a
  repeated prompt got `-2`, reconnect and fork re-passed the permission mode, a bad
  `--base` created nothing.

## Open

* Removing a thread does not offer to remove the worktree it created.
* No e2e for drag-and-drop images (wired, checked by hand in code).
* Remaining "session" copy that comes from the daemon: the restart/remove confirm
  messages and the "Sessions" settings group title.
