# Slash commands in the composer, PR 2 of 2: the GUI

Status: built on branch `t3code/composer-slash-command-shortlist-gui`, on top of PR 1
(`slash-commands-1-daemon.md`, PR #79, merged; this branch is rebased onto main). `make check`, `make gui-e2e` and `make gui-build`
green; exercised against a daemon built from this branch with an isolated home and a haiku
thread that did no work (below).

## What was built

* **`src/api/slashCommands.ts`**: `SlashCommandView {name, description, argumentHint,
  aliases, builtin}`, `toSlashCommandViews`, `shareCommands` (an unchanged list keeps its
  identity). `src/api/thread.ts`: the snapshot's `commands` and the Watch's `commands`
  event (`{kind: "commands", sessionId, seq, commands}`, empty when the process ended).
* **Thread store**: `ThreadLog.commands`, like `mcp`: replaced by a snapshot, by a
  `commands` event whose seq is above the log's (the generic seq rule), shared by value so
  an effort restart's identical list re-renders nothing. `useSlashCommands(sessionId)`
  (narrow; a stable empty list otherwise).
* **`lib/completion.ts`**: `commandScore` (6 the name, 5 a name prefix or an alias:
  `/cost` finds usage, 4 inside the name or an alias prefix, 3 a subsequence, 2 a
  description word), `firstLine`, `commandItems` (the grouping and the match floor below).
  `CompletionItem` gains `hint` (the argument hint) and `tag` may be a string (plain text);
  `CompletionGroup.heading` gains `{kind: "label", text}`.
* **Composer**: `useCommandSource` (`components/compose/useCompletion.ts`; listbox label
  "Slash commands", "No commands match"); `ThreadComposer` uses it while the thread's list
  is not empty and the disk scan (`useSkillSource`) otherwise. It keeps loading ListSkills
  either way: the scan is what tells a project skill from a user one. `PromptEditor` gains
  `insertText(range, text)` (the text and one space, or step over a space already there;
  one undo step), which `useCompletion` uses for a string row. `CompletionCard` renders the
  hint (`text-xs`, dimmer than the description, at most 40% of the row, truncated) and the
  label headings. The new-thread composer is untouched (no process: the disk scan).
* **Mock** (`mock/slashCommands.ts`): a 14-entry list in Claude's order (the scan's
  `deploy` and `review` with " (project)", the user's `commit`, nine built-ins including
  `code-review` (alias `review`), `compact`, `usage` (aliases `cost`, `stats`), then the
  plugin skills `pdf` (alias `anthropic-skills:pdf`) and `anthropic-skills:deep-research`),
  seeded with the MCP status on running threads; `snapshotValue` carries it,
  `ThreadService.SlashCommands` answers it, `POST /__mock/thread/commands?set=none|more|default`
  publishes a `commands` event. `thread.send` and `ThreadService.Send` refuse a replaced
  command with the daemon's exact text (`refuseSlashCommand`, before anything is recorded).

## Decisions

* **Grouping** (Alex's design: same card, one more group). A non-built-in command whose
  name the disk scan knows keeps its scope: under its project (the first member that has
  it, member order; a heading only when the thread has several projects, as before) or
  "User". Built-ins (Claude's `builtin`, bundled skills included) go under "Claude Code",
  last. Anything else (a plugin's skill, a skill Claude found that the scan did not, e.g.
  one in a subdirectory's `.claude/skills` discovered mid-turn) goes under one "Skills"
  group between "User" and "Claude Code". The scan is matched by name only; that is the
  "where derivable" of the brief and nothing more (no parsing of " (project)" or plugin
  prefixes). Within a group: score, then Claude's order. A built-in wins over a scanned
  skill of the same name (the daemon already keeps the built-in row, and `/name` runs it).
* **Insertion**: a scanned skill or command inserts today's tag (`cf-skill://…`, the same
  thing the disk-scan card does for a user's `commands/*.md` today: commands and skills
  are both tags there). Built-ins insert `/name ` as plain text (they take free-form
  arguments, and a tag would claim a scope they do not have). "Skills" rows also insert
  plain text: a tag needs a project or the user to point at, and they have neither.
* **Rows**: `/name`, the argument hint, the description's first line (CSS truncates the
  rest). Aliases only match; they are not shown. No tooltip: the card's rows have none and
  adding one per row for aliases alone was not worth it (the project rule allows tooltips
  for hidden info, so this is a possible follow-up, not a rule question).
* **Refusal**: no new code was needed. The thread composer already shows a failed send's
  message in its error line (`thread-composer-error`, red, under the pickers), keeps the
  draft (only a successful send clears it) and clears the error on the next edit; the
  daemon's INVALID_ARGUMENT passes through `CommandService.Invoke` unchanged
  (`commandError` keeps a Connect error) and `errorMessage` reads `rawMessage`, so the
  sentence shows as-is (backticks included). The e2e pins it.
* **No cold read in the GUI.** The thread composer only exists for the visible thread,
  which always holds the Watch, and the Watch's snapshot carries the list; so the GUI never
  calls `ThreadService.SlashCommands` (it stays for the CLI and other clients; the mock
  serves it). A daemon older than PR 1 sends no field 6: the list is empty and the card
  falls back to ListSkills, as before.
* **Match floor** (found in the live run, my call): with Claude's real list (43 rows, 13
  plugin skills with paragraph descriptions in "Skills" ahead of "Claude Code"), `/co`
  first showed eight plugin skills matched only by a scattered subsequence or a
  description word, and compact/code-review/context were below the fold. So once any row
  matches by name or alias (score 4+: exact, prefix, substring, alias), weaker matches
  are left out; with none, everything that matches shows. `/co` is now computer-use, then
  Claude Code's code-review, compact, context, update-config, usage. The disk-scan card's
  `skillScore` is unchanged.
* **Fallback is all or nothing.** While the list is not empty the card shows only it (what
  `/name` will actually run); the scan's skills that Claude does not list (it would not
  run them) are not mixed in.

## Gotchas

* With an empty query, the live list's order puts the project skill first, then 13
  plugin skills under "Skills", so "Claude Code" starts below the fold (~8 rows show).
  That is the agreed group order; worth a look if it feels wrong in use.

* The full suite's mock port 7799 can be taken by another worktree's run: `E2E_MOCK_PORT`
  / `E2E_VITE_PORT` move it.
* Fuzzy subsequence matching on Claude's long names is generous: `/dep` also matches
  `anthropic-skills:deep-research`. Ranking keeps the exact prefix first; the e2e asserts
  the first row, not the whole list.
* Description-word matches (score 2) bring in many built-ins for short queries (`/co`
  matches `simplify` through "code"); they sort after name and alias matches in each group.

## Verification

* `make check` green (vitest 103 files, 2031 tests after the rebase). New: `api/slashCommands.test.ts`
  (snapshot, event, empty on process end and on an older daemon; `shareCommands` table),
  `stores/thread.test.ts` (snapshot, seq rule, identity on an unchanged list and a resync,
  drop to empty, batching), `lib/completion.test.ts` (`commandScore` table incl. aliases,
  `firstLine`, `commandItems` table: one and several projects, `/co`, alias, plugin
  prefix, no match, unscanned skill, rows and tags, a built-in shadowing a scanned skill),
  `useCompletion.test.tsx` (a string row calls `insertText`, a tag row `insertTag`).
* `make gui-e2e`: before the rebase onto main, 652 passed, 28 skipped, 0 failed. After it
  (with #81): 648 passed, 6 failed (`usage-page.spec.ts:36`, `worktree-panel.spec.ts:109`
  in both browsers, `sessions.spec.ts:216` and `settings.spec.ts:193` in Chromium: intent
  delivered to 2 clients instead of 1, or one stream more than expected); those four specs
  alone: 58/58 passed. Nothing here touches intents or streams. `e2e/thread-slash-commands.spec.ts` (WebKit + Chromium):
  the card's groups `User`, `Skills`, `Claude Code` with `/deploy` first, the compact hint,
  a paragraph description cut to its first line (dark and light); `/co` → commit,
  code-review, compact, context, usage, …; `/cost` → only `/usage`, aliases not shown;
  `/comp` + Enter → `data-value` `/compact ` and no tag, then a `/deploy` tag, sent as
  `/compact keep the plan and /deploy`; `/clear please` + Enter → "Start a new thread
  instead of clearing this one." with the text kept and no send recorded, `/name new
  title` → the rename refusal, `/clearly fine` goes; `commands?set=none` → the card falls
  back to the scan (`User` only, listbox "Skills"), `set=more` → back, `/gamma` under
  Skills. `thread.spec.ts`'s `/revi` → `/review` tag still passes against the list.
* `make gui-build` green.
* **Live** (2026-10-13): `make gui-build`; `CODE_FOUNDRY_HOME=/tmp/cf-slash2-home
  ./bin/code-foundry daemon --dev`; `repo add ~/.cf-probe/slash` (project skill
  `alpha-probe`); `session new --repo … --worktree ~/.cf-probe/slash --model haiku --effort
  medium --permission supervised --name slash-gui` (no prompt, no turn); `thread commands`
  → 43. The built app with that home (`CODE_FOUNDRY_BIN=$PWD/bin/code-foundry "gui/bin/Code
  Foundry"`), `session focus`, keys typed with System Events into the process picked by
  its unix id, the window captured by its bounds. "/" showed `/alpha-probe` (no heading,
  one project), "Skills" (the plugin skills), "Claude Code"; `/co` as above;
  `/clear please` + Enter showed "Start a new thread instead of clearing this one." under
  the pickers with the text kept, and `thread items` stayed "(no items yet)". Daemon log:
  no WARN or ERROR. Thread closed, daemon stopped, the home removed.
* Screenshots (live app): `slash-commands-2-gui/card-dark.png` ("/"),
  `card-co-dark.png`, `card-co-light.png` (`/co`), `refused-light.png`.

## Daemon restart

Needed: the GUI reads the list from the Watch snapshot and `commands` events, which only a
daemon with PR #79 sends. An older daemon sends none and the card keeps today's disk scan;
nothing breaks. The refusal is PR #79's too.
