# The welcome page (2026-10-30)

A first-run tutorial for a user with no projects: one HTML page of four steps (say
something to it, point it at your work, put several agents on it, make it yours), shown in
the side panel of the thread the user starts with. It was iterated live with a user over
six rounds on a scratch home; this PR ships that v1 and the pieces the app needs around it.
The composer's prefilled first-run prompt is a later PR; it will read: "I just installed
Code Foundry and have no projects yet. This is the welcome tutorial: open the page
~/.code-foundry/pages/welcome.html in the side panel."

## What shipped

- **The page**: `internal/skills/files/code-foundry-pages/reference/welcome.html` (React
  through /cf/jsx.js, @cf/ui, the bridge), with `reference/welcome.md` beside it (how a
  thread shows it and answers its demo), a "The welcome tutorial" section in the help
  skill and a routing row in the entry skill.
- **The app places it**: at every daemon start, `skills.PlaceWelcome` writes the embedded
  page to `<home>/pages/welcome.html`, after the thread store's start-up cleanup of that
  root (`daemon.placeWelcome`, right after `installSkills`). The cleanup
  (`reapThreadDirs`) used to remove every entry of the pages, TMPDIR and page-storage roots
  that was not a live thread's id, files included; it now skips anything that is not a
  directory. The page is written only when its bytes differ (through a temporary file and
  a rename), so a page open in a panel does not reload at every start, and a stale or
  edited copy is replaced by the build's.
- **The skills name the real path**: a `{{cf.welcomePage}}` placeholder
  (`Sources.PagesDir`) fills in the absolute path in welcome.md and the help skill. The
  copy beside welcome.md stays as the fallback when the placed file is missing (it was the
  only source in the first rounds, and it worked).
- **The File tab follows writes outside every project**: page-card-reload.md's follow-up.
  A file with no project (all of `<home>/pages`) had no worktree event to re-read on, so a
  page opened with `view.panel.page` kept its old text after a Bash write. `FileTab` now
  calls `useFileChanges` (the inline card's stamp watch) for such a file and keeps
  `useToolEdits` for project files, where the worktree events already cover writes.
- **e2e**: `e2e/welcome-page.spec.ts` against the mock: the real page at the placed path in
  the panel of a no-project thread (`POST /__mock/welcome`: empty world, the thread and one
  busy child it created), the four steps, a step-1 bubble sending its sentence
  (`thread.send`), Add a project opening the dialog, the board's child going Working →
  Finished → Needs permission, and the tab reloading on a write of the file.

## Decisions

- **Panel first, never inline.** The page opens with `view.panel.page`, beside the
  conversation: the user learns the side panel on the first screen, and later pages they
  ask for show inline. The first rounds used `view.inline`; the user moved it.
- **A pre-placed file, not a page the model writes.** Measured on scratch homes: a
  template in markdown retyped by the model took over two minutes and about 30 steps; a
  premade file the thread only shows takes seconds with the exact reply. Pre-placing it
  lets the prompt name one fixed path, so a "walk me through" prompt does not route to the
  help skill and improvise (round 6). The skills embed is the one source: the daemon reads
  the same file the pages skill ships, no second copy.
- **The skills package places it.** It owns the embedded file and already writes files at
  start; the thread store only learned to leave files alone. The thread store does not
  import skills.
- **Progress in page storage.** Sent bubbles, the demo, dictation, one-shot buttons and the
  scroll position are kept with `cf.storage`, so the page remembers what was done across
  reloads and restarts.
- **The demo sentence names the project** (name and id) and asks for three read-only
  threads out of the sidebar, and forbids a second board: the welcome page's own board
  lists the thread's children live.
- **Finished vs needs you by reason.** A finished child is `attention` with reason
  `finished` (by design); the board reads the reason: `finished` (or none) is Finished,
  `permission: …` Needs permission, `question: …` Asked a question, anything else Needs
  you.
- **The mock opens the dialog for project.add from a thread**, as the daemon does for a
  thread a window shows (page-verbs.md); it used to answer the CLI hint, which the page
  shows as an alert.

## Rejected by the user

- An inline card for the tutorial (panel first instead).
- A "my threads right now" bubble (a new user has only the intro thread) and a timer page
  bubble (the welcome page already teaches sending); the to-do page that keeps everything
  replaced them.
- "Forget it" after the memory bubble (it failed when the saved text differed): Open
  memories and a one-shot Reset memory instead.
- Two add buttons (one Add a project button), sidebar rows for the demo threads, and a
  board of the thread's own beside the page's.
- "The box below" in the copy: the page is in the panel, so it says "composer".

## Gotchas

- The pages root's cleanup ran before anything else wrote there, so a top-level file was
  deleted at every start; anything placed in a per-thread root must be a file, or the
  cleanup must learn its name.
- Scratch homes for page tests must live under `~`: pages outside the home are refused.
- The skills tests' verb check skipped verbs without args (`dictation.status`), reporting
  them as unknown; every listed verb now counts.
- The help and entry skills' line caps went up (121, 84) for the tutorial section and the
  routing row; the help skill is what a first run's thread reads first.

## Verified

- Go: `TestPlaceWelcome` (no root yet, first start, an older build's page, this build's
  page left alone; a thread's pages kept), `TestSpawnChildContext` (a file in the TMPDIR
  and pages roots survives New, gone threads' directories are still pruned),
  `TestRenderPagesSkill` (the placed path in welcome.md and the help skill).
- Playwright: welcome-page.spec.ts; without the FileTab change its reload step fails.
  file-tabs, page-verbs-panel and page-card-reload still pass.
- Real daemon and GUI on a scratch home: see the PR body.
