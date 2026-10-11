# Composer tags 4: file tags and `@` completion

Status: done on branch `cf/composer-file-tags` (PR 4 of 4 for composer skill and file
tags). GUI only, on top of PR 2's `FilesystemService.SearchFiles` and the daemon's
`@cf-file://` rewrite (`composer-tags-1-daemon.md`) and PR 3's card, tag node and file
tag token (`composer-tags-3-skills.md`). Design: `/tmp/cf-composer/index.html`
(`?h=a&t=a&multi=1&pop=file`, `&tip=file`), `final-pop-file.png`, `final-tags.png`,
`tip-file.png`.

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/lib/completion.ts` | `CompletionItem` / `CompletionGroup` moved here (`mono`, `emphasis`); `fileSources`, `fileSourcesKey`, `emphasis`, `fileItems` (pure, table-tested) |
| `gui/frontend/src/stores/files.ts` | `requestFiles` (debounce, per-member fan-out, request sequence, `searching`, cache), `cancelFiles`, `useFilesEntry` |
| `gui/frontend/src/components/compose/useCompletion.ts` | `useFileSource`; the source model gains `label`, `query` (what the rows answer) and `searching`; the card waits for an asynchronous source |
| `gui/frontend/src/components/compose/CompletionCard.tsx` | monospace labels, emphasized detail ranges, "Searching…", label from the source |
| `gui/frontend/src/components/compose/{Composer.tsx,tagContext.ts,TagView.tsx}` | `@` trigger, source by trigger character, `TagMultiProjectContext`, the file tooltip |
| `gui/frontend/e2e/composer-files.spec.ts` | mock e2e; `e2e/live-files.spec.ts` (opt-in, real daemon) |

## Decisions

* **Rows**: the bold monospace base name (a directory with a trailing `/`), then the muted
  relative path with the matched characters in the foreground. The daemon ranks; the UI only
  marks (`emphasis`), case-insensitive: the query as a run in the base name, else spread
  over the base name (greedy), else as a run anywhere, else spread over the whole path.
  Preferring the base name keeps `src/api/session.ts` for `ses` from marking the `s` of
  `src`. Rows keep the daemon's order.
* **Groups**: a group per project with matches, primary first, then member order; project
  headings (same dot and name as skills) only with more than one project. Skills keep member
  order, as before.
* **Insertion**: the tag's label is the base name (directories keep the `/`), its path the
  relative path (a directory's ends with `/`, which the daemon keeps). PR 3's `insertTag`
  adds the space.
* **Sources** (`fileSources`): a workspace in "Workspace worktrees" mode searches each
  member's worktree; a lone project's chosen existing worktree (incl. a no-git project's
  folder) that worktree; everything else (new worktree, a project with Also in, a workspace
  in new-worktree mode) each project's main checkout (no `path`). That differs from skills,
  which read a workspace's member worktrees in both modes.
* **Requests** (`stores/files.ts`): `requestFiles(sources, query)` on every change of the
  trigger's query (an effect keyed on the source list and the query, so arrow keys and
  re-renders send nothing). Debounced 80 ms per source list; then one `searchFiles` per
  member at once (`limit` 30), joined with `allSettled`. Each send bumps a per-list sequence;
  an answer lands only if no later request's answer has landed (`seq > applied`), so an
  older answer that arrives first is shown until the newer one lands, and one that arrives
  after it is dropped. Nothing is aborted. A member whose search fails (not outdated)
  answers with no matches.
* **Cache**: the last answer per source list stays in the store. Asking again for the
  answered query within 5 s (the daemon's own cache TTL) sends nothing; after that the old
  answer shows at once while it refreshes. Asking for the query whose request is already
  out sends nothing either. A closed trigger cancels only a pending debounce.
* **Searching…**: `searching` turns on when the latest request has been out 300 ms; the
  card then says "Searching…" (no footer) instead of the rows, until the answer lands. Fast
  answers never show it.
* **The card with an asynchronous source** (`useCompletion`): the source says which query
  its rows answer. If that is the trigger's, or this trigger was answered before (same
  position), the card runs `nextCard` on the answered query, so the rows follow along while
  typing and the "No files match" rule works as for skills. A trigger nothing has answered
  yet waits with the card closed.
* **Enter while waiting does nothing** (beyond the brief): typing `@READ` and pressing Enter
  inside the debounce window sent the half-typed `@READ` as text (the card was still
  closed). Now Enter is swallowed until the first answer (or Escape); then the card is up
  and Enter inserts. Found while taking the screenshots; e2e covers it.
* **Outdated daemon**: an Unimplemented answer marks the entry outdated; the source is then
  unavailable (no card, `@` stays text), and nothing is asked again for that member set.
* **Tooltip**: one monospace line, the relative path; with more than one project the
  project's name first (`sketches/internal/api/session.go`). Whether the draft has several
  projects comes from `TagMultiProjectContext`, provided by the composer around the editor
  (node views render in portals under `EditorContent`, so React context reaches them). The
  muted project line PR 3 had prepared is gone (the design has one line).
* **Member changes**: PR 3's Also in removal (`removeAlsoIn`, the confirm in `MemberChips`)
  and the project switch (`retainRepoTags`) already remove file tags by repo id; the unit
  tests (`stores/compose.test.ts`, `lib/compose.test.ts`) had file cases, and the new e2e
  covers the Also in removal end to end. Nothing needed fixing.

## Gotchas

* Radix tooltips render a visually hidden copy of the content (for `aria-describedby`), so
  the tooltip test id's text is doubled; the e2e reads the visible `<p>`.
* The mock ranks with path subsequences too, so `session.go` also matches
  `internal/store/session/manager.go`; specs set their own file lists.
* Removing a tag through the Also in confirm trims the trailing space (removeReferences'
  spacing), as in the skills spec.
* The worktree had no `third_party/ghostty-vt`; copied the main checkout's and fixed the
  `.pc` prefixes (as in PR 2).

## Live check (scratch daemon, 2026-10-11)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-pr4/home bin/code-foundry daemon --dev`; scratch
repo `~/cf-pr4-scratch/filedemo` (one commit: `README.md` whose first line is
`FILEDEMO-FIRST-LINE-4417`, `src/index.ts`, `docs/notes.md`); `repo add` →
`2d3f34798037`. Vite on the daemon (`VITE_DAEMON_URL` / `VITE_DAEMON_TOKEN`), then
`LIVE_DAEMON=1 … pnpm run e2e:live e2e/live-files.spec.ts` in WebKit: cmd+N, cmd+1, Haiku,
Medium, "New worktree", typed `print the first line of @READ` → the card showed
`README.md` / `READ`ME.md → Enter → tag `README.md` + space, typed `and stop`; tooltip
`README.md` → Enter.

* daemon argv: `claude --session-id … --model haiku --effort medium --permission-mode auto
  --add-dir …/attachments -- print the first line of
  @/private/tmp/cf-pr4/home/worktrees/_local/filedemo/cf-print-readme-first-line/README.md
  and stop`, cwd that new `cf/print-readme-first-line` worktree;
* transcript: the first user message has the same absolute path; Claude Code's `@` mention
  attached the file itself (a `file` attachment record with `filePath` the new worktree's
  `README.md` and its content), no Read tool call; the answer: `FILEDEMO-FIRST-LINE-4417`
  (`end_turn`);
* daemon log: no WARN or ERROR. Thread closed by the spec; daemon and Vite stopped; the
  scratch home, repo and both `~/.claude/projects` dirs (the thread's and the namer's)
  removed.

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck, lint,
  vitest (1209).
* Vitest: `lib/completion.test.ts` (`fileSources` table per worktree mode, `emphasis`
  table, `fileItems` rows and grouping table); `stores/files.test.ts` (faked SearchFiles,
  fake timers: debounce, fan-out with and without path, a failing member, stale answers both
  ways, `searching` timing, cache and refresh, query already out, `cancelFiles`, outdated,
  and the requests per worktree mode as a table).
* e2e (`composer-files.spec.ts`, WebKit + Chromium): `@ses` rows (`session/`, `session.go`,
  `session.ts`, `manager.go`; monospace; `ses` emphasized; listbox "Files"; footer) → Enter
  inserts `session.go` + space without sending → send's prompt is
  `@cf-file://repo-cf/internal/api/session.go explain it`; single-project tooltip is the
  path; Escape keeps `@ses`; "No files match"; Tab inserts `README.md`; a click inserts the
  directory `session/` (tooltip `internal/store/session/`); arrow navigation and re-opening
  the same query add no `/__mock/files/calls` entries; Also in → groups `code-foundry`,
  `sketches` (and `sketches` first once it is primary), tooltips with the project prefix,
  × → confirm (cancel keeps, confirm removes the project and its file tag), tooltip without
  prefix after; Enter inside the debounce does not send; SearchFiles missing → no card,
  `@sesx` sent as text. The skills, switch and compose specs pass unchanged.
* `make gui-e2e` and `make gui-build`: see the PR.

## Daemon restart

Nothing beyond PR #37's: the installed daemon must already have SearchFiles and the
`@cf-file://` rewrite. An older daemon answers Unimplemented and the composer offers no `@`
card.
