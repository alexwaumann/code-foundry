# Workspaces v2, PR 5: skills and prompt

Status: done on branch `cf/workspaces-v2-skills`, after PR 2
(`workspaces-v2-2-workspaces.md`). Design record: `workspaces-v2-handoff.md` §7 and §8
step 5. Skill text, `ThreadPrompt`, one command description and their tests; no daemon
behaviour changes. Needs a daemon restart (the prompt and skills are compiled in).

## What landed

| Path | What |
|---|---|
| `internal/skills/files/code-foundry/SKILL.md` | "Scopes": app memory for how to act everywhere; the workspace's folder (the `WORKSPACE` row of `thread checkouts`) for what spans a set of projects, `CLAUDE.md` (else `AGENTS.md`; a new file is `CLAUDE.md`) and `.claude/skills/<name>/SKILL.md` with `name`/`description` frontmatter; a repo's own `CLAUDE.md` for one repo; read another checkout's `CLAUDE.md` (INSTRUCTIONS column) before editing there; a running thread loads new ones at its next start. The routing row for preferences points at it; the description says "wants a skill" |
| `internal/skills/files/code-foundry-orchestrate/SKILL.md` | step 1: a child inherits projects, workspace, branch and mode; without `--new-worktree` (or `--new-branch`) it shares your worktrees, one worker per checkout (`thread new` warns); `--projects` keeps it to the projects its task touches; the example is `thread new --projects <project id> --new-worktree`. Step 5: archiving removes clean worktrees no other thread uses, never a branch. "Give it a new branch" instead of "a new worktree" |
| `.../code-foundry-orchestrate/reference/patterns.md` | §2c "A change across several projects": `thread checkouts`, one child per project with `--projects`, `--project` for where a multi-project child starts, reading each member's `CLAUDE.md`; §7 no longer says a workspace holds a worktree |
| `internal/skills/files/code-foundry-help/SKILL.md` | "Workspaces": what one is, the Projects page card, Save as workspace, `workspace new`, its folder (`workspace list`) and files; "Remembering preferences" names the workspace's `CLAUDE.md`; "workspaces" in the description |
| `.../code-foundry-plugin/reference/host-api.md` | an environment's `Projects` scope matches any project of a multi-project thread (it said "workspace thread … member") |
| `internal/store/thread/workspace.go` | `ThreadPrompt`: "a rule or skill for a workspace's projects: the folder code-foundry thread checkouts prints (CLAUDE.md, .claude/skills), not a repo" after the memory add clause; cuts to stay at 1,549 of 1,550 bytes (below) |
| `internal/command/commands_thread_checkouts.go` | description: "List a thread's projects (path, branch, CLAUDE.md) and its workspace's folder." |
| `internal/skills/skills_test.go`, `internal/store/thread/prompt_test.go` | the new text pinned; the help cap 105 → 109 |

## Decisions

* **`ThreadPrompt` got a scope clause, not the `thread new` clause.** The brief preferred
  leaving it alone and relying on the skill. The eval showed that does not work: with the
  old prompt, "Remember for this workspace that …" went to `memory add` at once (2 of 2,
  Haiku 5.5): the prompt's "how you should act in every project (always, never …) goes to
  memory add at once, without asking" wins before any skill loads. A first clause ("for one
  workspace: its CLAUDE.md (code-foundry thread checkouts)") sent it to the primary repo's
  `CLAUDE.md`; "its folder's …, not a repo's" fixed that; naming skills there was needed
  for the skill case. The `thread new` clause stays as it was: children inheriting the set
  is the orchestrate skill's to say, and the bytes went to the scope clause.
* **Cuts in `ThreadPrompt`** (it was at its 1,550 cap): "code-foundry-help for app
  questions" (was "to answer questions about the app"), "to show:" (was "to show
  something:"), "never suggest /model or /cost" (was "never tell the user to type"),
  "(project.github.publish off GitHub)" (was "if not on GitHub"), "Work split up" (was
  "Work the user wants split up"), "code-foundry-orchestrate, never hand-made worktrees or
  branches, nor the Agent tool (read-only research)" (was "(child threads in new
  worktrees), never the Agent tool, hand-made worktrees or hand-made cf/ branches; the
  Agent tool is for read-only research"). The test pins moved with the wording; no rule
  is gone.
* **Orchestrate inheritance.** Inside a thread a child copies the creator's set, workspace,
  branch and mode (PR 1's placement), so the old "`--new-worktree` so it never edits your
  checkout" was right only for single-project parents. A multi-project parent's
  `--project X --new-worktree` child gets a worktree in every member (seen in the eval);
  the example now uses `--projects <id>`, which for a single-project parent places the
  same thread as `--project` did (it differs only by keeping the creator's workspace
  reference). `--new-branch` is named as the same thing as `--new-worktree` here.
* **Archive removes worktrees now** (PR 1's cleanup on archive). Step 5 said "It keeps the
  worktree and branch"; it now says clean worktrees no other thread uses go, never a
  branch. "6. Clean up only after merge" folded into the Cleanup section it pointed at.
* **Caps.** Entry 83 of 83 lines, description 399 of 400; orchestrate 138 of 138 (the
  brief's "205 lines, rules 6 KB" are Ember's caps; the orchestrate test's cap is 138);
  the guide 25,473 of the 25,500 split cap; `ThreadPrompt` 1,549 of 1,550. **The help
  skill's cap went 105 → 109** (still under the 120 it had before control-7): the
  workspaces answer is 7 lines and the reflows found only 3. Recorded in the test.
* **What was trimmed for room.** Entry: the intro to three lines, "Showing things" lost
  its first paragraph (the panel verbs, `--focus` and `--panel` moved into the routing
  table rows; page verbs and path chips are `ThreadPrompt`'s), the "standing preferences
  are in your system prompt" bullet (the memory heading says so), a blank line in "The one
  rule". Orchestrate: the intro (the thread id is in Conventions), the `thread subscribe
  --pr` id note (step 2 shows it), `("budget reached")` and the model/effort defaults, the
  `--yes` and exit-code lines merged, the More list compressed and its `code-foundry help`
  /`guide` line merged into the commands line. Help: the "Commands you run (the CLI, with
  your Bash tool)" sentence shortened, the restart sentence and the `memory remove` line
  on one line each, two bullets reflowed.
* **Help's labels are the handoff's** (Projects page cards, "Save as workspace"): PRs 3 and 4
  build them; the fuzz round should check the help text against what shipped.
* **The pages skill's `sources.md`** reads right for the GUI as it is: `workspace` items
  with `members` (worktree path and branch always ""), `rootPath`, `defaultPrimary`,
  `managedDir`; thread-list items have no `projectIds` yet (the GUI view does not map it).
  PRs 3 and 4 change both and should update `sources.md` with them.
* **No eval harness exists** in the repo (the routing evals in control-7/control-8 were
  manual scratch-daemon runs), so these were too.

## Eval (2026-10-25, scratch daemon)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cfv2-skills`, a clean environment (`env -i`, the
branch's `bin` first on `PATH`, no `CLAUDE*`/`CODE_FOUNDRY_*` variables); scratch repos
`web` and `api` under `~/cfv2-skills-scratch` with a `CLAUDE.md` each (api's: every new file
starts with `# owned by the api team`); `workspace new shop --projects web,api`
(synthetic); threads `thread new --workspace shop` (primary web, checkout mode), Haiku 5.5
at medium unless noted, `projects.base_from_origin false` (no origin).

| Case | Build | Result |
|---|---|---|
| "Remember for this workspace that both services deploy with make deploy …" | old prompt | `memory add` at once, 2 of 2 |
| same | clause v1 ("its CLAUDE.md") | edited `web/CLAUDE.md` (the primary repo's) |
| same, and a second fact (VERSION files) | final | loaded the entry skill, ran `thread checkouts`, wrote `<managed dir>/CLAUDE.md`; app memory empty, repos untouched, 2 of 2 |
| "Make a skill for running the whole stack: the api with go run . … the web site with python3 -m http.server 3000." | entry Scopes only | `web/.claude/skills/run-stack/SKILL.md`, 2 of 2 |
| same | final | Haiku: `<managed dir>/.claude/skills/run-stack/SKILL.md` 1 of 3 (twice `web/.claude/skills`); Sonnet 5.5 medium: the managed dir, after `thread checkouts`, 2 of 2 |
| a new workspace thread: "Is there a skill available to you for running the whole stack?" | final | "Yes, it's `run-stack`" (the managed dir's skill loads) |
| "Add a /health endpoint to the api … show the api's health in the web page's footer. Split this across workers, one per repo …" | before the `--projects` example | `thread new --project api --new-worktree` and `--project web …`: each child got both projects and a worktree in each |
| same | final | `thread new --projects e6b1… --new-worktree` and `--projects 147a… --new-worktree`: one project each, workspace kept, own branch; archiving the three removed both worktrees at once ("its branch stays") |
| "In the api repo, add a VERSION file containing 0.1.0." (primary web) | final | read `api/CLAUDE.md` first, wrote the file with `# owned by the api team` |

The Haiku miss on the skill case: a "make a skill" prompt reads as a coding task in the
cwd; neither the prompt clause nor the entry skill's description ("wants a skill") made it
look up the workspace's folder every time. Sonnet did each time. Left as is; see
follow-ups.

## Gotchas

* The sandbox refuses inline scripts whose text names git (including "GitHub"); the
  prompt and skill edits ran as script files.
* A worker in the eval left `python3 -m http.server 3000` running in its worktree after it
  finished; killed by hand.

## Follow-ups

* A workspace thread's system prompt names the workspace only when its `CLAUDE.md` exists
  (the appended block). Naming the managed dir there (one line, even with no instructions
  yet) would likely fix the Haiku skill miss; it is a daemon change (and the handoff
  dropped the "This thread belongs to workspace" line on purpose), so not here.
* Check the help skill's labels against PRs 3 and 4 (cards, "Save as workspace", "New
  thread on this branch"); update `sources.md` when they map `projectIds` and drop the v1
  member fields.
* A rooted workspace with only `AGENTS.md`: the entry skill says to add to the file that
  exists; a model that writes `CLAUDE.md` in the managed dir makes a real file there that
  then wins over the linked `AGENTS.md`. Not seen; worth a fuzz probe.
