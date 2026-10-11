# Composer tags 3: skill tags and the `/` completion card

Status: done on branch `cf/composer-skill-tags` (PR 3 of 4 for composer skill and file
tags). GUI only, on top of PR 2's `FilesystemService.ListSkills`
(`composer-tags-1-daemon.md`) and PR #38 (the heading's project switch,
`composer-tags-2-switch.md`), merged in; the switch now cleans up tags. PR 4 adds the `@` file
source to the plumbing built here. `make check`, `make gui-e2e` and `make gui-build`
green; exercised against a real scratch daemon with a haiku thread (below).

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/lib/prompt.ts` | `PromptPiece` is text or `{kind:"tag", tagKind:"image"\|"skill"\|"file", …}`; `tagToken`, `tagLabel`, `encodeTagPath`; skill and file projection; `tagsByRepo`, `repoTagCount`, `removeRepoTags`, `retainRepoTags` |
| `gui/frontend/src/lib/completion.ts` | `findTrigger`, `nextCard` / `dismissCard` (when the card shows), `skillScore`, `groupSkills`, `skillSources`, `skillSourcesKey` (pure, table-tested) |
| `gui/frontend/src/stores/skills.ts` | ListSkills per source list (+ user), `loadSkills`, `useSkills`, `useSkillDescription` |
| `gui/frontend/src/components/compose/tagNode.ts`, `tagContext.ts`, `tagSelection.ts`, `tagStyle.ts`, `TagView.tsx` | the generalized node (was `chipNode.ts` / `chipContext.ts` / `chipSelection.ts`): attrs `kind, id, name, repoId, path`; a view per kind |
| `gui/frontend/src/components/compose/AttachmentChip.tsx` | the image view, unchanged look (shares `tagClass`) |
| `gui/frontend/src/components/compose/useCompletion.ts`, `CompletionCard.tsx` | the card's state, keys and insertion (source-agnostic) and `useSkillSource` |
| `gui/frontend/src/components/compose/PromptEditor.tsx` | trigger reporting, completion keys first, `insertTag`, one `TooltipProvider` |
| `gui/frontend/src/components/compose/{Composer,MemberChips}.tsx`, `stores/compose.ts` | card under the composer card; skills loaded per member set; Also in removal drops that project's tags (confirm when any) |
| `gui/frontend/e2e/composer-skills.spec.ts` | mock e2e; `e2e/live-skills.spec.ts` (opt-in, real daemon) |

## Decisions

* **Tokens** (draft text; `lib/prompt.ts` header): image `![name](cf-attachment://id)`
  unchanged; skill `[/name](cf-skill://~/name)` (user) or `[/name](cf-skill://<repoId>/name)`;
  file `[label](cf-file://<repoId>/<path>)` with each path segment percent-encoded
  (`encodeURIComponent` plus `! ' ( ) *`, so `)` cannot end the token) and a directory's
  trailing `/` kept. Skill and file labels are derived from the URL, never read back from
  the token, so a hand-edited label cannot lie. A token that does not decode (bad escape, a
  `/` in a skill name, a user-scope file) stays plain text.
* **Projection** (send): skill → `/name`, file → `@cf-file://<repoId>/<encoded path>` (the
  daemon decodes it, PR 2). Both get one space after them when anything but whitespace
  follows, because a slash command and the daemon's file token end at whitespace. Insertion
  already adds the space; this covers a user who deletes it.
* **`proseOf`** strips image chips only: a skill tag counts as prose for the image-chip
  insertion rule.
* **The heading's project switch** (PR #38, merged into this branch): `movedDraft` takes the
  target workspace's member ids and keeps only the tags of the moved draft's members
  (`retainRepoTags(text, [to, ...alsoIn])`, or the workspace's members); images and user
  skills always stay. `switchDraftTarget` compares `tagsByRepo` before and after: when tags
  would go it asks first ("Switch to <target>?", "<n> reference(s) to <project(s)> in your
  text will be removed.", confirm label "Switch"), before the existing "Replace the draft"
  confirm; cancel leaves draft and selection as they were. The check is synchronous and
  awaits only when there is something to ask, so the replace confirm still opens at once.
* **Also in removal**: `removeAlsoIn` (store) always removes the project's tags.
  `MemberChips`' × asks first when the text refers to it: "Remove <name> from the thread?",
  "<n> reference(s) in your text will be removed.", confirm label "Remove" (centered, like
  the image confirm). No references: no question. The project itself and workspace members
  cannot be removed in the composer, so there is nothing else to clean up here.
* **Skill sources** (`skillSources`): a workspace's member worktrees (both modes); a lone
  project's chosen existing worktree (incl. a no-git project's folder); else each project's
  main worktree (no path). User scope always. Cached per source list
  (`skillSourcesKey`); the composer calls `loadSkills` on mount and when the list changes;
  a reload keeps the old list, concurrent loads share one request. A failed reload keeps a
  loaded list; an outdated daemon (Unimplemented) empties it and the card never opens (no
  notice).
* **Grouping**: project groups in member order, user last. Project headings (dot in
  `projectHue(name)`, `oklch(0.55 0.13 h)` like the project badge, then the name) only when
  the draft has more than one project; the "User" heading always (it is a different scope).
  A non-member's project skills are dropped; a name listed twice in one group (a skill and a
  command) shows once. The sketch showed a project heading for a single project too; the
  written design limits it to several projects and that is what the e2e asserts.
* **Matching**: case-insensitive; name exact 5 > prefix 4 > subsequence 3 > a description
  word starting with the query 2; empty query lists everything. Within a group: score,
  then the daemon's order (by name).
* **Trigger**: `/` at the start of a paragraph or after whitespace, then non-whitespace up
  to the caret (tags read as U+FFFC, so `/` right after a tag or inside `and/or` is not a
  trigger). Only while the prompt has focus and is editable.
* **When the card shows** (`nextCard`, idempotent so it runs during render): matches show;
  the first query with none shows "No skills match"; the next character closes it (a
  longer query cannot match again); Backspace back to the no-match query says it again,
  further back reopens the list. Escape dismisses the trigger (keyed by its position) until
  the caret leaves it; the text stays. Space ends the trigger. Enter on "No skills match"
  dismisses it (does not send); Tab passes through there.
* **Keys**: the editor offers ArrowUp/Down, Enter, Tab, Escape (no modifiers) to the card
  before anything else, so Enter never sends while the card is open and `cycleStops` sees
  Tab already handled. Arrows wrap. Shift+Enter still makes a new line.
* **Insertion**: `insertTag(range, tag)` replaces `/query` with the tag and one space (or
  steps over a space already there) in one chain, so it is one undo step. A click on a row
  inserts; the card's mousedown is prevented so the prompt keeps focus; hovering a row
  selects it.
* **Card**: in the composer grid between the card and the worktree row (in flow, rows
  shift down), same surface as the card (`rounded-2xl border bg-card/85 backdrop-blur-xl
  shadow-sm`), `mt-2`, full width. 13px, 28px rows, ~8 rows then scroll, the selected row
  `bg-accent` with ⏎, footer `↑ ↓ move · ⏎ ⇥ insert · esc dismiss` (hidden on "No skills
  match"). ARIA: listbox/option; the prompt gets `aria-autocomplete="list"` and, while open,
  `aria-controls` / `aria-activedescendant`.
* **Tags**: text only, the image chip's box (`tagClass`), `--chip-accent` per kind via
  Tailwind arbitrary properties with a `dark:` variant: skill `oklch(0.62 0.17 300)` /
  `oklch(0.78 0.14 300)`, file `oklch(0.6 0.14 230)` / `oklch(0.78 0.12 230)`. Images keep
  their sampled accent, thumbnail and size, and Space-to-preview (`selectedChipId` now
  ignores non-image tags).
* **Tooltip**: Radix via `components/ui/tooltip.tsx`, one `TooltipProvider` around the
  editor, the `NodeViewWrapper` itself is the trigger (it forwards ref and props).
  `disableHoverableContent` (nothing to click in it; with hoverable content the tooltip did
  not close when the pointer jumped away in the e2e). Skill: "User skill" or "Project skill
  · <name>", the description muted below (looked up in any cached skill list). File
  (ready for PR 4): the path in mono, the project muted below.
* **For PR 4**: add `"@"` to `TRIGGERS` in `Composer.tsx`, a `useFileSource(trigger, …)`
  returning a `CompletionSource` (`char: "@"`, groups of rows with `tag: {tagKind:"file",
  repoId, path}`, `emptyText: "No files match"`), and pick the source by `trigger.char`.
  The file tag view, token, projection and tooltip exist already.

## Gotchas

* The status reads idle before Claude's first turn starts, so "wait for idle" is not "wait
  for the answer"; the live spec waits for an assistant text line in the transcript.
* ProseMirror groups edits within 500 ms into one undo step: the e2e waits 600 ms before
  the deletion it undoes (like the image-chip spec).
* `RegExp.matchAll` items must be typed `RegExpExecArray` (`index` is then a number).
* The React Compiler lint rejects `useCallback`s whose inferred deps differ; the hook uses
  plain functions and a ref synced in a layout effect for the editor's callbacks.
* Worktree-isolated agents cannot `cd` elsewhere and run git; the scratch repo used
  `git -C <abs path>`.

## Live check (scratch daemon, 2026-10-10)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-pr3/home bin/code-foundry daemon --dev`; scratch repo
`~/cf-pr3-scratch/skilldemo` (one commit: `README.md`, `.claude/skills/demo/SKILL.md` with
description "A demo skill for the PR 3 live check." and the body "reply with exactly the line
DEMO-SKILL-RAN-7731 …"); `repo add` → `02ec52291c69`. ListSkills over Connect JSON returned
`demo` (project). Vite pointed at the daemon (`VITE_DAEMON_URL` / `VITE_DAEMON_TOKEN`) and
`LIVE_DAEMON=1 … pnpm run e2e:live e2e/live-skills.spec.ts` in WebKit: cmd+N, cmd+1, Haiku
5.5, Medium, typed `/dem` → the card showed `/demo` → Enter → tag `/demo` + space, typed
`now`; the tooltip read "Project skill · skilldemo / A demo skill for the PR 3 live check."
→ Enter.

* daemon argv: `claude --session-id … --model haiku --effort medium --permission-mode auto
  --add-dir …/attachments -- /demo now`, cwd the new `cf/demo-now` worktree;
* transcript, first user message: `<command-name>/demo</command-name>` with
  `<command-args>now</command-args>` (Claude Code took it as the skill), then the skill's
  base-directory message; the answer: `DEMO-SKILL-RAN-7731` (`end_turn`);
* daemon log: no WARN or ERROR. Threads closed by the spec; daemon and Vite stopped; the
  scratch home, repo and the `~/.claude/projects` dirs removed.

A first run closed the thread at "idle" before the turn (see the gotcha); the slash command
had already been recognised in that transcript.

## Verified

* `make check` (after merging main): gofmt, vet, staticcheck, `go test -race ./...`,
  frontend typecheck, lint, vitest (1166).
* `make gui-e2e` (after merging main): 401 passed, 4 skipped, 1 failed: Chromium
  `gitops.spec.ts:17` (the push toast never showed "running" within 5 s). This branch does
  not touch gitops; it failed the same way in an earlier full run and passes alone (the
  whole spec, 5/5), so it is a timing flake of the full suite.
* Vitest: `lib/prompt.test.ts` (tokens, round trip of every kind, labels, malformed tokens,
  projection and spacing, `tagsByRepo`, `repoTagCount`, `removeRepoTags`, `retainRepoTags`,
  every existing case), `lib/completion.test.ts` (trigger table, card rules incl.
  idempotence and Escape, scoring and grouping tables, sources), `stores/skills.test.ts`
  (faked ListSkills: keying, shared in-flight, stale-while-reload, outdated),
  `stores/compose.test.ts` (Also in removal drops the project's tags only),
  `components/compose/tagSelection.test.ts` (image only; attrs round trip).
* e2e (WebKit + Chromium) for this work: `composer-switch.spec.ts` gains "switching away
  drops the old project's skill tags after a confirm" (cancel keeps text, project and Also
  in; confirm keeps sketches' and the user's tags), and `composer-skills.spec.ts`: `/dep` → card
  with `/deploy` under the composer card and above the worktree row → Enter inserts the tag
  and a space without sending → send's prompt is `/deploy to staging`; Escape keeps `/dep`
  and stays dismissed; "No skills match" for one keystroke, closed on the next, back on
  Backspace; description match; Tab and click insert; Enter on "No skills match" does not
  send; Backspace removes a tag whole, undo restores it, a pasted token becomes a tag;
  tooltips for project and user skills; Also in → groups `code-foundry`, `sketches`, `User`
  → inserting sketches' `/deploy` → × → confirm (cancel keeps, confirm removes the project
  and the tag) → no confirm without references; ListSkills missing → no card, `/dep` sent as
  text. The compose and workspaces specs pass unchanged.
* `make gui-build` green.

## Daemon restart

Nothing beyond PR #37's: the installed daemon needs a restart for ListSkills (and the file
reference rewrite). An older daemon answers Unimplemented and the composer simply offers no
`/` card.
