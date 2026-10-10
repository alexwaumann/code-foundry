# Linked pull requests

A thread knows which pull requests its conversation produced or touched. The source is
Claude Code itself: it writes a dedicated record to the session's transcript
(`~/.claude/projects/<slug>/<session-id>.jsonl`) whenever it sees a pull request for the
session's repository. This chunk is the daemon half (store, table, proto, API, CLI,
GUI view model, mock); the UI is the GUI chunk (below).

## The record

```json
{"type":"pr-link","sessionId":"86345896-68fe-4fe2-9d80-965185527884","prNumber":5,"prUrl":"https://github.com/alexwaumann/code-foundry/pull/5","prRepository":"alexwaumann/code-foundry","timestamp":"2026-10-09T18:24:11.771Z"}
```

Facts, checked against a real transcript (61 pr-link lines for PRs #5 to #13):

* It is written when a PR is created by `gh pr create` in the session, created by a
  subagent in another worktree, or only named in the prompt.
* It is re-emitted dozens of times for the rest of the session, at nearly every turn
  boundary.
* It tracks "the latest PR seen" and can flip back to an earlier one (the sample goes
  12, 12, 11, 11, 13). #8 never appears: Claude never saw it.
* The parent session writes it even when a subagent made the PR; subagent transcripts
  (`<session-id>/subagents/*.jsonl`) do not contain it. We only tail the parent file.

## Decisions

* **Every distinct URL, first-seen order, never removed.** Deduplicated by URL. The
  first record of a URL gives `linked_at`; a record without a parseable timestamp gets
  the time it was seen. "Latest" flipping back is ignored: a flip-back is not news.
* **Parser** `internal/store/session/prlink.go`: `parsePRLink` runs on every transcript
  line, so it does a byte search for `"pr-link"` before any JSON decode (the same cheap
  pre-filter style as `internal/claudestatus/transcript.go`, which is untouched). It
  rejects a record with an empty `prUrl`, a `prNumber` <= 0, or an empty
  `prRepository`, and anything whose decoded `type` is not `pr-link` (a user message
  quoting the string passes the pre-filter and fails here).
* **Runner wiring.** `runner.pollTranscript` collects the pr-link records of a poll's
  lines and hands them to `Manager.linkPullRequests` once per poll. That merges under
  `m.mu`; only new URLs are inserted and published (one `Updated`), so the dozens of
  re-emissions cost a lock and a slice scan each and publish nothing. Detector and
  naming calls are unchanged.
* **Backfill on resume and reconnect.** A resumed transcript is tailed from its end
  (`tailer.fromEnd`): the history is not news for status, but its links are. On
  discovery of a file opened from the end, the runner streams the bytes the tailer
  skipped (`tailer.skipped`) through `scanPRLinks`, once, before any new line, so
  first-seen order holds. Reconnect resumes, so a thread that linked PRs before this
  shipped gets them on its next reconnect. It runs on the runner goroutine (never the
  terminal actor) and streams in 64 KiB chunks with the tailer's own line splitter
  (extracted as `lineSplitter`), so lines over 8 MiB are skipped, never buffered whole.
  The full 7.2 MB sample scans in about 8 ms. Disconnected threads are not scanned at
  daemon startup; only a reconnect backfills.
* **Copy on write.** `Session.LinkedPullRequests` is replaced by a new slice on every
  change and its backing array is never written (`mergeLinks` appends to a clipped
  slice), so snapshot copies, which copy `Session` by value, can share it safely. This
  is the deep-copy guarantee without copying on every snapshot rebuild.
* **Fork and /clear.** A fork's and a `/clear`ed conversation's transcript is read from
  its start, so whatever pr-link records it carries are picked up as live lines. A fork
  does not inherit the parent's list otherwise.
* **No fixture capture harness.** Alex is the sole heavy user and runs Claude Code all
  day; if Claude changes or drops the record he will notice the missing links. A
  harness that records real sessions to catch format drift is not worth its upkeep now.
* **No cross-check against Bash output** (e.g. parsing `gh pr create` stdout for the
  URL). Claude's record already covers subagent and prompt-named PRs, which a Bash
  scraper would miss. Revisit only if the record proves unreliable.

## Table

Migration `0010_session_pull_requests.sql`:

```sql
CREATE TABLE session_pull_requests (
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    slug       TEXT NOT NULL,
    number     INTEGER NOT NULL,
    url        TEXT NOT NULL,
    linked_at  INTEGER NOT NULL,             -- unix ms
    PRIMARY KEY (session_id, url)
) STRICT;
CREATE INDEX session_pull_requests_session ON session_pull_requests (session_id);
```

`saveLinks` inserts new links (`ON CONFLICT DO NOTHING`, one transaction) as they are
seen; `loadLinks` reads all rows in one query ordered by `session_id, rowid` (insertion
order is first-seen order) and `loadSessions` attaches them. Removing a thread removes
its rows by cascade. The explicit index duplicates the primary key's prefix; it was in
the brief and is harmless.

## Proto and clients

`Session.linked_pull_requests = 25`, `repeated LinkedPullRequest` with `slug`
("owner/name"), `number`, `url`, `linked_at`. Mapped in `internal/api/session.go`
(`sessionToProto`).

* CLI: `session list` has a `PRS` column (`#5,#6`, each prefixed with the repository
  name when a thread linked PRs in more than one repository, e.g. `api#5,web#2`; `-`
  when none). `--json` carries the full records.
* GUI: `SessionView.linkedPullRequests: { slug, number, url, linkedAt }[]` (`linkedAt`
  epoch ms or null) in `src/api/session.ts`. `sameSession` compares the list by URL so an
  unchanged session keeps its identity.
* Mock daemon: sessions carry the field (empty by default);
  `POST /__mock/link-pr?session=<id>&slug=<owner/name>&number=<n>` appends
  `https://github.com/<slug>/pull/<n>` unless that URL is already linked, republishes the
  session, and returns `{ added, ...session summary }` (400 for a bad slug or number,
  404 for an unknown session).

## Verified

* `make check` green: gofmt, vet, staticcheck, `go test -race ./...`, frontend
  typecheck, lint, 779 vitest tests.
* Unit tests (`internal/store/session/prlink_test.go`, fixture
  `testdata/prlink.jsonl`: 24 real lines cut from the sample, 18 pr-link records for 8
  URLs including the 12 -> 11 flip-back, plus unrelated records): `TestParsePRLink`
  (captured records, an unrelated record, a user message quoting "pr-link", malformed
  JSON, missing url, zero and negative number, missing repository, wrong-typed number,
  missing and bad timestamp); `TestMergeLinks` (dedup within a batch and against the
  current list, flip-back order, no write into a shared backing array);
  `TestScanPRLinks` (whole file, byte limit, an over-8 MiB line between records, last
  line without a newline, missing file); `TestSaveAndLoadLinks` (insertion order,
  duplicate URL ignored and first row kept, foreign key enforced, attached by
  `loadSessions`).
* Through the public store API (`Manager` with a fake terminal store and a temp Claude
  dir): `TestLinkedPullRequestsFromLiveTranscript` (live lines link 5, 6, 7 with the
  first record's time; re-emitted records publish no `Updated`; the rest arrive in
  first-seen order; a restart loads all 8 in order) and
  `TestLinkedPullRequestsBackfillOnReconnect` (records written while disconnected are
  backfilled on `Reconnect` and are not fed to the status detector; a live record after
  the resume appends after them; `Remove` cascades the rows).
* API: `TestSessionUnaryAndErrorCodes` checks the proto mapping (order, fields, an unset
  `linked_at`). CLI: `session.list` table rows for a single and a mixed-repository list.
  GUI: `mapping.test.ts` (mapping, empty default), `sessions.test.ts` (identity kept for
  an equal list, changed for a longer one).
* End to end, scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-lprs/home`, `bin/code-foundry
  daemon --dev`), scratch repo `~/cf-lprs-scratch/scratch` (registration is home-only),
  real `claude` thread `--model haiku --effort medium --permission auto` with the prompt
  "Reply with just the word OK.":
  1. Appended a pr-link record (#5, sessionId rewritten) to the live transcript:
     `session list` showed `#5` within 2 s with `linkedAt` from the record. A repeat
     changed nothing.
  2. `session close`, appended 14 more sample records (#6 to #12 and the flip back to
     #11), `session reconnect`: `claude --resume`, and `session list` showed
     `#5,#6,#7,#9,#10,#11,#12` once connected, status "idle / at prompt" (the history did
     not raise attention). Daemon log: `backfilled linked pull requests records=16 new=6
     bytes=197978 took=1ms`.
  3. Appended #13 live after the resume: appended last. `session_pull_requests` held the
     8 rows in first-seen order with the records' times.
  4. Daemon stopped with SIGTERM and auto-started by the CLI: the thread listed
     disconnected ("daemon stopped") with all 8 links. No warnings or errors in the log.
  5. Daemon stopped; scratch home, scratch repo and its `~/.claude/projects` dir removed
     (the trust entry for the scratch path stays in `~/.claude.json`, harmless).
* Mock: `POST /__mock/link-pr` against `pnpm run mock`: added, a repeat not added,
  `SessionService/Get` returns both links with `linkedAt`; bad slug 400, unknown session
  404.

Not verified: a pr-link record written by Claude itself in a live daemon session (that
needs a pull request on a GitHub remote; the e2e appended real captured records instead,
which is the same input to the parser). Claude re-reading appended records on `--resume`
was not inspected.

## GUI chunk

The thread's linked pull requests as a side panel surface, a thread header button and a
sidebar badge. Branch `cf/linked-prs`, after the daemon chunk above. The panel and its
registry: `side-panel.md`; the closest prior surface: `workspaces-5-panel.md`.

### What landed

| Path | What |
|---|---|
| `internal/command/commands_view.go` | `view.panel.linked-prs` ("Show Linked PRs in Side Panel", View, no chord), emits `ShowView{"panel.linked-prs"}`; `When` = `hasSession` (any thread, with or without links) |
| `gui/frontend/src/surfaces/linkedprs.ts` | The surface spec: kind `linkedprs`, title "Linked PRs", hotkey L, `enabled` for a thread (or a thread's terminal) with at least one link, `hidden` otherwise |
| `gui/frontend/src/surfaces/linkedprsTarget.ts` | Pure: `selectionThread` / `selectionLinkedThread` (availability), `linkedPrsTab`, `newestFirst`, `spansRepos`, the count and badge labels |
| `gui/frontend/src/components/linkedprs/LinkedPRsSurface.tsx` | Header (thread name, "N linked PRs") and the rows as a keyboard listbox |
| `gui/frontend/src/stores/linkedPrsPanel.ts` | `linkedPrsTarget` (linked / none / no-thread), `openLinkedPrsSurface` |
| `gui/frontend/src/stores/views.ts`, `keys/bindings.ts` | `linkedPrsPanelCommand`, `showView("panel.linked-prs")`, the local presenter |
| `gui/frontend/src/components/terminal/TerminalPane.tsx`, `command/CommandButton.tsx` | Header button with the link count (`CommandButton` got an optional `count`) |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | The `N PR(s)` badge on a thread row opens the surface for that thread |
| `gui/frontend/mock` | `view.panel.linked-prs`; `/__mock/link-pr` takes `ago=<ms>`; PR detail fixture #147 (open, 2 of 14 checks failing, on no dashboard) |
| `gui/frontend/e2e/linkedprs.spec.ts` | mock e2e (5 tests per engine); `SHOTS=<dir>` saves the screenshots below |

### Decisions

* **Hidden, not disabled, without links.** The empty panel lists Linked PRs (with its L
  chip) only once the thread has a link, and the list updates live when one arrives
  (`watches` the sessions store). A plain terminal, worktree, page or composer has no
  thread: hidden too. L does nothing while it is hidden.
* **The thread comes from the selection**, not tab params (like the workspace surface):
  one tab per panel, no params, so a tab restored from storage still follows its thread.
  A thread's terminal resolves to its thread through `deriveContext`, which is also what
  the Go command's `When` sees.
* **Rows, newest linked first** (the stored first-seen order reversed). Two lines, 48px:
  `#N`, title, state chip (Open / Draft / Merged / Closed, the PR surface's tones) and,
  for open pull requests only, the compact CI icon; then the head branch, the repository
  only when the links span more than one, and "linked 5m ago" (the record's time). A
  link whose details are loading shows the URL's host and a skeleton bar; a failed load
  shows "details unavailable" and still opens.
* **No new RPCs or pollers.** Each row watches `pullRequestDetailResource`, the PR
  surface's own resource, so the daemon re-reads it while shown and the tab opened from
  a row starts warm. The list is short (a thread links a handful of PRs) and virtualizes
  through `RowList` past its threshold anyway.
* **Click or Enter opens the PR as its own `#N` tab in the same panel**
  (`openPullRequestInPanel`); focus moves to the panel first, because the list unmounts
  when the tab switches, so cmd+w closes the PR tab and lands back on the list.
  cmd+Enter / cmd+click open on GitHub. Hover (or the keyboard-selected row) reveals Open
  on GitHub (`view.open.url`) and Copy link.
* **Entry points.** L in the panel; `view.panel.linked-prs` from the palette, the CLI
  (`ShowView`) and the thread header's PR button, which shows the count and is rendered
  only with at least one link; the sidebar's `N PR(s)` badge (emerald, left of the
  workspace badge) opens the surface in that thread's panel and the click goes on to the
  row, which selects it.
* **The command is available for any thread**, even without links, so the palette finds
  it; the GUI then toasts "No linked PRs yet" instead of opening an empty surface. A
  window whose selection is not a thread ignores the ShowView. Like
  `view.panel.workspace` it has no default chord; from the palette the palette's return
  target becomes the panel.
* **Mock data.** s-1's four links in the e2e and screenshots are existing fixtures (#142
  open passing, #145 draft failing, #138 merged) plus #147, added for this chunk as an
  open pull request with failing checks that is on no dashboard. It got a full detail
  (body, commits, the 14 check runs its rollup counts) after the first screenshots showed
  "2 failing" over an empty checks list.

### Deviations

* "Skeleton while gh data loads" is per row (host + bar), not a list-level skeleton: the
  rows are known from the session at once; only their details wait on gh.
* No live daemon run: the surface reads only `Session.linked_pull_requests` (exercised
  end to end in the daemon chunk) and the existing PR detail resource (exercised by the
  PR surface's live spec).

### Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck,
  lint, 807 vitest tests (56 files).
* `make gui-e2e`: 304 passed (WebKit + Chromium, 152 each), 4 skipped, including `linkedprs.spec.ts` (5 tests per engine; the two
  screenshot tests skip without `SHOTS`).
* Go: `TestViewPanelLinkedPRsAvailability` (project and workspace thread, a thread's
  terminal, plain terminal, worktree, composer, nothing, CLI with and without
  `--context-session`) and the `TestViewCommandsEmitShowView` row.
* Vitest: `surfaces/linkedprsTarget.test.ts` (availability over selection kinds, order,
  tab, labels); `surfaces/linkedprs.test.tsx` (listed with L only with links and
  following new ones, header and rows newest first with skeletons until details load,
  repository names across repositories, Enter and click open a PR tab in the same panel,
  `linkedPrsPanelCommand`: opens and shows the panel, toasts without links, no-ops
  without a thread and under settings, palette return target).
* Playwright (`e2e/linkedprs.spec.ts`, WebKit + Chromium): hidden without links, then
  `/__mock/link-pr` brings the badge ("1 PR", "2 PRs"), the header button with its count
  and the enabled L entry; L, the header button and the CLI's ShowView open the tab with
  rows #142, #147, #145, #138 (titles, states, CI, branches, "linked 5m ago"); Enter and
  a click open `#147` / `#138` tabs in the same panel and cmd+w comes back; the badge on
  another thread selects it and lists two repositories; hover Copy link and Open on
  GitHub; the palette toasts for a thread without links and does not list the command
  for a plain terminal.
* Screenshots (WebKit, 1400x900, mock daemon, dark and `-light`):
  `/tmp/cf-shots/linkedprs-empty-list.png`, `linkedprs-list.png`, `linkedprs-pr-tab.png`,
  `linkedprs-header-sidebar.png` (`SHOTS=/tmp/cf-shots pnpm exec playwright test
  e2e/linkedprs.spec.ts -g screenshots --project webkit`).
* `make gui-build` green.

### Daemon restart

The installed daemon must be restarted (it needs the daemon chunk anyway: without
`linked_pull_requests` every thread has no links, so the surface, button and badge never
appear). With the new daemon but an old GUI nothing changes; with a new GUI and the new
daemon the palette entry and header button come from `view.panel.linked-prs`.
