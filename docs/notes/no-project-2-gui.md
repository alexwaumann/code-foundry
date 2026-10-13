# Project-less threads, step 2: the GUI

Status: done on branch `t3code/no-project-gui` (PR b of 2, stacked on PR a,
`t3code/no-project-daemon`, #86). `make check` and `make gui-e2e` green; exercised in an
isolated copy of the built app with a real haiku thread (below).

## What landed

| Path | What |
|---|---|
| `lib/threadRow.ts` | `NO_PROJECT`, `isNoProject(session, repos)`: empty `workspaceId` and `repoId` and a cwd inside no known worktree; `ThreadRowModel.noProject`; `projectOfPath` also places an older row by a containing worktree |
| `lib/path.ts` | `isWithin` (segment-boundary prefix) |
| `stores/context.ts` | a no-project thread's context has no repo and no worktree |
| `lib/compose.ts` | `ComposeTarget` `{ kind: "home" }`, `HOME_KEY` (`home:`), `ThreadPlace` `{ kind: "home" }`, `threadArgs` → `no-project: true` alone |
| `stores/compose.ts`, `stores/ui.ts`, `stores/panel.ts`, `App.tsx` | compose selection `noProject`, `composeNoProject`, `composeSelection`, switching to and from home |
| `components/compose/ProjectRows.tsx`, `ProjectPicker.tsx`, `ProjectSwitcher.tsx` | the "No project" row (House badge, `~`) last, below a separator; also in the empty state |
| `components/compose/Composer.tsx` | heading "What should we build with No project?"; no worktree, base, branch or member chips; `/` only |
| `components/sidebar/SidebarRow.tsx`, `RowMenu.tsx`, `components/session/SessionParts.tsx`, `components/start/StartPage.tsx` | "No project" (House icon where a project icon shows), no branch; no Show worktree |
| `components/thread/ThreadComposer.tsx` | a no-project thread's follow-up composer: user skills for `/`, no `@` |
| `surfaces/noProject.ts`, `files.ts`, `diff.ts`, `pullrequest.ts` | hidden for a no-project thread or composer |
| `stores/bottomPanel.ts`, `components/bottom/BottomPanel.tsx` | a shell in the thread's home is titled "No project" |
| `components/session/useNoProject.ts` | `useNoProjectThread(id)`: narrow selectors over the helper |
| `mock/world.ts`, `e2e/no-project.spec.ts` | the mock's `session.new --no-project`; the e2e flow |

## Decisions

* **One helper.** `isNoProject` is the only test; everything else (row model, context,
  surfaces, composer sources, bottom tab title) goes through it or `ThreadRowModel.noProject`.
  An older row with an empty repo id inside a project is not one: it is placed by its path
  (now also by a containing worktree, not only an exact one).
* **Context.** A selected no-project thread sends `activeRepoId` and `activeWorktreePath`
  empty (PR a's gotcha). `placeSession` would have put home there and kept `session.new`
  available without `--no-project`, which the daemon refuses, and offered worktree
  commands on home. `terminal.new` still works: the active thread owns the shell and
  starts it in the thread's cwd. cmd+N always opens the picker anyway (its presenter).
* **Picker row.** Last, below a separator and without a heading (a "Without a project"
  heading over a "No project" row said the same thing twice). Value `home:`, keywords
  "No project", "home", "~". No cmd+number, and the first row stays highlighted, also
  when the active thread has no project (the brief: Enter right after cmd+N picks the
  first project). Shown once projects have loaded, so the order never jumps. In the empty
  state it follows "Add a project…", which stays highlighted; "No projects yet." as the
  empty text went (a query that matches nothing says "No matching projects.").
* **Composer heading.** "What should we build **with** No project?" ("in No project"
  does not read). The switcher's label is plain "No project" like a project name (the
  heading never had a badge).
* **Composer card.** For home: no member chips, no worktree picker, no branch indicator,
  no base picker; the row under the card stays (it anchors the completion card). The
  send button says "Starting Claude…" (no worktree is made). Model, effort and
  permission (Auto) as for any composer.
* **Completion.** Home's composer and a no-project thread's follow-up composer take `/`
  only: the PromptEditor's triggers drop `@`, so SearchFiles never runs on `~`. `/`
  lists the user's skills (ListSkills with no sources) or, in a running thread, Claude's
  slash commands.
* **Moving a draft to home** drops Also in, primary and base and every project tag
  (skills, files of any project), behind the usual "Switch to No project?" confirm;
  images and user skills stay. From home to a project or workspace it starts fresh
  (a new worktree, or the workspace's worktrees).
* **Side panel.** Files, Diff and Pull request are hidden (Workspace and Worktree already
  were: no workspace, and no worktree in the context). Linked PRs (enabled when Claude
  linked one), Usage and MCP stay.
* **Bottom panel.** A thread's shell without an OSC title is named after its cwd's last
  segment; for a no-project thread a shell in its home says "No project" instead of the
  user's home folder name (one cd'd elsewhere keeps its folder name). Owner labels come
  from the daemon unchanged (`repo=` empty, `worktree=` home).
* **Start page** rows say "running · No project". The onboarding (zero projects) is
  unchanged; the cmd+N picker still offers No project there.
* **Not touched.** RunIn: the daemon offers `session.run-in` for workspace threads only,
  so a no-project thread never shows it. UserBubble file chips and completion-card
  project headings never meet a no-project thread (no file tags; headings only with two
  or more projects). The Usage page has no project column.

## Gotchas

* Prettier is not the formatter here (no config): running it rewrote a whole file at 80
  columns. Leave formatting to eslint and hand edits.
* `bottomTabTitleOf` stays a primitive selector: the no-project flag is a second narrow
  selector in the tab (`useNoProjectThread(sessionOfKey(panelKey))`), passed in.
* cmdk in jsdom needs `scrollIntoView` and `ResizeObserver` stubs (ProjectPicker.test).
* Port 7799 may be another worktree's mock: `E2E_MOCK_PORT=7841 E2E_VITE_PORT=9297 make gui-e2e`.

## Verification

* Unit: `isNoProject` table (home, older rows inside a worktree or a no-git checkout, a
  sibling with a shared prefix), the row model, the context (no repo, no worktree; the
  no-project composer), draft key / members / place / `threadArgs` → `no-project`,
  `movedDraft` to and from home (tags, Also in), `switchDraftTarget` to home and back
  (with the tag confirm), picker order (No project last, no shortcut, first row
  highlighted, empty state), composer hiding, sidebar line 2, header, surface
  availability, bottom tab title.
* e2e (`e2e/no-project.spec.ts`, WebKit + Chromium): cmd+N, the row last and searchable,
  the composer without worktree controls, `@` opens nothing, send (`session.new` args
  `no-project` with no repo or worktree), header and row say No project, the panel lists
  Usage and MCP only, cmd+t opens a shell titled No project with an empty repo/worktree
  context, cmd+N from the thread opens the picker.
* Live: `make gui-build`, `CODE_FOUNDRY_HOME=/tmp/cf-noproj-gui CODE_FOUNDRY_BIN=bin/code-foundry
  "gui/bin/Code Foundry"`, a scratch git project under `~/cf-scratch-noproj`, defaults
  haiku/medium. cmd+N → No project → "Reply with just OK. Do not read or edit any
  files." → thread `repoId` empty, cwd `/Users/alex`, "claude: OK" on claude-haiku-5-5.
  Sidebar row "No project", header House + "No project", side panel Usage and MCP only;
  cmd+t opened a shell at `~` labelled `repo= worktree=/Users/alex`, tab "No project".
  Session closed and removed, its transcript deleted, the app and its daemon stopped,
  `/tmp/cf-noproj-gui` and the scratch repo deleted.

Screenshots (dark and light): `no-project-2-gui/picker-*.png`, `composer-*.png`,
`thread-*.png`, and `shell-light.png`.

## Daemon restart

Needs PR a's daemon (the `no-project` arg); nothing new on the daemon side here.
