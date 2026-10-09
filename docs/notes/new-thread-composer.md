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

## Feedback pass (2026-10-09, after Alex tried it)

* **Composer centering.** It was positioned with `mt-[14vh]` against the window; it now
  sits at `m-auto` in a flex column so it is centered in the content pane at every size,
  scrolling from the top when the draft is taller than the pane.
* **Inline image chips (T3 Code parity).** The prompt is a TipTap 3 editor (Document,
  Paragraph, Text, History, HardBreak plus one inline atom node), chosen because T3
  Code's chip is a ProseMirror atom and a plain textarea cannot hold a styled inline pill
  that moves as one unit. The draft text stays a string; a chip is the token
  `![name](cf-attachment://<id>)`. T3's rules: a chip is inserted at the caret only when
  the prompt already has prose or a selection is replaced (an image pasted into an empty
  prompt gets only the thumbnail); a space before unless whitespace precedes, always one
  after. Arrow keys step over a chip; Backspace/Delete remove it as one unit and leave
  the thumbnail; undo restores it. × on a referenced thumbnail opens a centered confirm
  ("Remove <name> from the message?" / "It is referenced in your text; removing it also
  removes every reference.", destructive Confirm); unreferenced thumbnails are removed
  with no dialog. On send each chip becomes `[Image: <name>; ref=<staged path>]` in
  place, and `attachments` still carries the staged paths (the daemon appends its own
  `Attached image:` lines). Source studied: github.com/pingdotgg/t3code
  (`ComposerPromptEditorTiptap.tsx`, `ChatComposer.tsx`, `ContextChip.tsx`).
* **Local-only repositories.** `Repo.remotes` (sorted remote names) is filled from
  `git remote` on every check; empty before the first check too, so empty is only
  "local-only" once the repo has been checked. `git.fetch`, `git.pull`, `git.push`,
  `pr.create`, `pr.open` are unavailable for such repos (`Command.WhyUnavailable` →
  "repository has no remote"); GitOpsService refuses them before recording an op.
  `ListRefs` returns local branches with `default_ref: "main"`; `--fetch` is a no-op.
  The picker subtitle says "Local only", else the GitHub slug or remote name.
* **Outdated daemon.** Connect maps HTTP 404 to `Unimplemented`; `listRefs` and
  `stageAttachment` turn that into "The running daemon is older than the app. Restart
  it…" (`src/api/errors.ts`). Alex hit this because the GUI was talking to the daemon
  from the main checkout.
* **Mock controls** added: `POST /__mock/missing-rpc?rpc=…` (404 for a call),
  `GET /__mock/attachments`, `POST /__mock/session-new?delay=`; a local-only repo
  `sketches` in the mock world. Drag-and-drop now has an e2e.
* Verified again on a scratch daemon with a repo that has no remote: picker shows "Local
  only", base picker lists `main` (default) and `feature-x`, a pasted image became a chip,
  Enter created `cf/describe-project-overview` from `main`, and the argv carried
  `… -- Describe … [Image: shot.png; ref=<staged path>]\n\nAttached image: <path>`.

## Open

* Removing a thread does not offer to remove the worktree it created.
* Remaining "session" copy that comes from the daemon: the restart/remove confirm
  messages and the "Sessions" settings group title.
* The main bundle is over Vite's 500 kB warning; unmeasured whether TipTap pushed it
  there.
