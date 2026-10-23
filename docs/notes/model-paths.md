# Paths a model writes open the right file

A user (2026-10-23): "when a model shows paths, it should show relative paths (to its
cwd) or absolute paths so that a user clicking it can actually open the file properly in
the side panel." A path chip (file-viewer-4-chips) resolves a relative path against the
thread's cwd. A model that had `cd`'d into a subfolder wrote `src/foo.ts` for
`gui/frontend/src/foo.ts`, or cut a path short, and the click opened "File not found".
Two parts: a prompt rule (the fix) and a File tab fallback (a safety net).

## 1. ThreadPrompt

The clause "a path in your reply is a clickable chip;" became:

> a path in your reply is a clickable chip: write it in full, absolute or relative to
> your primary working directory (not a folder you cd into), with :line for a line;

* "Primary working directory" is the label Claude Code's own environment block uses for
  the cwd, and it tells that directory apart from the `--add-dir` ones (skills,
  attachments, a workspace's other members). "Not a folder you cd into" names the
  failure: the Bash tool's cwd moves, the chip's base does not.
* Workspace threads need no extra clause. Another member's worktree is outside the
  primary working directory, so the rule already makes such a path absolute (or `../…`,
  which resolvePath folds correctly). workspacePrompt is unchanged.
* Ember's rules (`internal/store/ember/files/rules.md`) and the orchestrate skill say
  nothing about how to write paths; nothing contradicts. Ember's chat chips only absolute
  paths under a project (projectPlace), which the rule allows. The entry skill's "A path
  in your reply is a chip that opens the file." still holds. It is at its 70-line cap,
  so it is not repeated there.
* Size: 1,426 → 1,550 bytes (+124, roughly 30 tokens on every request). The cap was 1,430
  with "grow it only by cutting". Every other clause was tuned in an A/B
  (control-7-skill-routing, inline-html, thread-new-base-origin) and is pinned by
  `TestSystemPrompt`. Cutting about 120 bytes of them without a new A/B risked the routing
  they buy, so the cap moved to 1,550 instead. The test pins the whole new clause. A
  shorter wording ("…write it in full, absolute or relative to your primary working
  directory, …", 142 bytes in all) was considered. It dropped the cd hint, which names
  the failure that was actually seen.

## 2. File tab fallback

The brief's candidates were the project root when the cwd is a subfolder, then the cwd's
prefix segments joined. They can never fire: a thread's cwd is always a checkout's root.
A project's path is the repository's main worktree (project.projectRoot), a new worktree
is a whole checkout, a workspace thread runs in a member's worktree, and a no-project
thread runs in home. So the fallback asks the existing file search instead. No new RPC.

* `FileTab`'s read (the one place a File tab first reads its file): when the read is not
  found and the tab has a project, `findMissing` calls `FilesystemService.SearchFiles`
  (the composer's "@" search, cached a few seconds per checkout) on the tab's base. It
  searches for the path's file name, limit 200. `uniqueSuffixMatch` keeps the matches
  whose checkout-relative path ends with the typed one at a segment boundary. If exactly
  one matches, that file is read and is the tab's. The header, `data-path`, tool-edit and
  worktree refreshes all follow `file.path`. With none or several, or when the search
  fails (an older daemon), the original "File not found" shows as before.
* Once per tab: a ref keyed by base + path keeps what the search found, or null. Refresh
  and Retry read that directly and never search again (Retry after nothing was found
  reads the typed path again, so a file created later still shows up).
* Truncation: internal/fuzzy ranks an exact file name above everything else. A list cut
  at 200 whose last entry still has that name may have dropped a second candidate, so
  that case is no match.
* Pure parts: `src/lib/pathFallback.ts` (`fallbackQuery`, `uniqueSuffixMatch`, table
  tests). The async glue is `src/components/files/findMissing.ts`, with its search
  injectable and tested.
* No-project threads (base = home) do not search: SearchFiles needs a project, and home is
  no place to guess in.
* Not done: the tab stays keyed by the typed path. Opening the resolved path from another
  chip makes a second tab for the same file. Rewriting the tab's id after the read would
  touch the panel store, which the brief ruled out.

No visible change beyond the right file opening, so no screenshots.

## Verified

* `make check` green.
* Vitest: `src/lib/pathFallback.test.ts` (22 cases), `findMissing.test.ts`, and two new
  `FileTab.test.tsx` cases (found once, then Refresh without a second search; two
  candidates or no project stay not found).
* Playwright on the mock daemon (WebKit): `file-tabs.spec.ts` gains "a path missing at the
  checkout opens the one file that ends with it". `app.ts` with line 12 opens
  `src/app.ts` at 12, and `spec.pdf` listed twice stays not found. `path-chips.spec.ts`
  and `paths.spec.ts` pass.
* Live: see below.

## Live check (2026-10-23)

`make build`, then a daemon on an isolated home (`CODE_FOUNDRY_HOME=/tmp/cf-model-paths/home`)
with the CLAUDE* variables unset. `project.add` refuses /tmp (home only), so the scratch
repository was `~/cf-scratch-model-paths` (README.md, web/package.json, an empty
web/src), deleted afterwards. One thread: `claude-haiku-5-5[1m]`, medium effort, auto.

1. "Go into web/src with cd, create two small TypeScript files there (greet.ts and
   math.ts), then tell me which two files you created and their paths."
   The model ran `cd …/web/src` and wrote both files. Reply:
   `/Users/alex/cf-scratch-model-paths/web/src/greet.ts` and
   `/Users/alex/cf-scratch-model-paths/web/src/math.ts`. Absolute; both chips open.
2. "Still working from web/src, add math.test.ts next to math.ts with one test for add.
   Then give me a short list of the files in web/src and where add is defined."
   Reply: "I added `web/src/math.test.ts` …", "`add` is defined at `web/src/math.ts:1`":
   relative to the cwd with the line, so they resolve. The list under "Files in
   `web/src`:" used bare names (`greet.ts`, `math.ts`, `math.test.ts`). Those chips
   resolve to the checkout root, where nothing is. Each name is in exactly one place, so
   the File tab fallback opens the right file. This is why part 2 stays: the rule moved
   every sentence-level path to a resolvable form, but a list headed by its folder still
   reads naturally to the model with short names.
