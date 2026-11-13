# Shell gaps C: the host seam finds a tab by its identity

Gaps 20 to 24 of docs/notes/shell-21-remove-classic.md ("The host seam's tab identity"). Each was a
vitest marked `it.skip` with a `// Shell gap:` line. All of them run now except gap 23's, which is
replaced (below). Nothing else was skipped.

## The identity rule as it stands

A tab is the same tab as another when it has the same layout kind, the same link (the thread it is
linked to, or none) and the same identity key in its scope (space, or global for threads and
terminals). The key reads only the kind's key params, with the daemon's normalisation:

| Kind | Key | Key params |
| --- | --- | --- |
| diff | `diff:<link>:<project>:<worktree>[:by:<asker>][:<title>]` | project, worktree, **thread** (the asker), title |
| file | `file:<path>` | path |
| pullrequest | `pr:<slug, lower case>#<number>` (a positive number in canonical spelling) | slug, number |
| terminal | `term:<terminal>` | terminal |
| gallery | `gallery:<link>:<title>` | title |
| mcp | `mcp:<link>` | - |
| compose | `compose`, or `compose:draft:<id>` | draft |
| plugin.* | `plugin:<plugin>/<surface>/<scope>` | scope |
| thread, prs, projects, ember.board | the kind (a thread's: `thread:<id>`) | - |

Every other param (a diff's sides, file, filter, folds, note; a file's line or request; a pull
request's slug spelling) never tells two tabs apart. Opening a tab whose identity is open uses that
tab.

**What changed in the table:** a diff's key gained the `thread` param, the thread that framed it
(`internal/layout.DiffAskerParam`). view.open.diff already set it on every call that names a side,
narrows the list, sets a note, a title or `--hide` (commands_view_diff.go). So a diff is one per
thread and checkout, the user's, plus one per asker (and per asker and title) for what a thread frames.
`identity.go`, `testdata/kinds.json` and the window's port (`gui/frontend/src/shell/identity.ts`)
changed together. A stored layout re-keys on load (decode.go notes the change); a titled diff's key
gains `:by:<asker>`, which splits nothing that was one tab.

## One identity function

`gui/frontend/src/shell/identity.ts` is the window's only port of the identity table: the kinds,
their links, scopes, key params and key functions. The host seam (`hostShell.ts findByIdentity`),
the mock daemon (`mock/layout.ts identify`, which had its own copy) and the menus' keys
(`shell/linked.ts diffKey`, `prKey`) use it. Two pins hold it to the daemon:

- `identity.test.ts` compares the table with `internal/layout/testdata/kinds.json`.
- It runs every row of `internal/layout/testdata/identity.json`, which Go's `TestIdentify` writes
  from its own table (`-update`), and it gets the same key or the same refusal.

## The gaps, by cause

20. **The seam's id was all the params.** `hostShell.ts panelIdOf` hashed every param of a layout tab
    (a File tab's path alone) and compared it with the seam id a surface made. A Diff tab with a file
    or other sides picked was never found, so a reopen went to the daemon as a new open, whose rule 1
    replaced the tab's params (the reset). A pull request's seam id is lower case
    (`pullRequestTabId`) but the hash used the slug's spelling, so a mixed-case tab was never found.
    Now a seam id is parsed back into its kind and params (`tabs.ts parseTabId`, tabId's inverse) and
    the seam matches tabs by identity among the target's tabs, computing both keys with the shared
    function. Callers that compared a seam id with a layout id by hand use `findTab` now:
    `threadPanelIntent.ts` (a thread's diff call finding the user's tab) and `prLinks.ts` (the anchor
    check). The pull request tab keeps the spelling it was opened with and its pane takes the focus.
21. **A thread's untitled framed diff was the user's tab.** The daemon's key was thread, project and
    worktree, so view.open.diff with a side or a note (an asker, no title) landed on the user's own
    tab and replaced its filter, folds and sides. The specification fixes "a diff is one per thread
    and checkout", and shell-7-view-open.md says a titled diff is the thread's own tab; what must
    hold is that a thread's call never replaces what the user has in theirs. Both halves agree now:
    - the key reads the asker (above), so a framed call gets the thread's own tab (the window titles
      it "From thread …");
    - a call that frames nothing (no asker: it only picks a file) shows an open checkout tab as the
      user has it. The daemon's `tabs.open` sends the open tab's own params with open_surface instead
      of the call's (`commands_view_open.go`, `TestViewOpenDiffKeepsTheUsersTab`), and the mock does
      the same (`mock/panelItemVerbs.ts keepUsersDiff`). The window then picks the file there when
      the user's sides list it, else opens it in a tab of the thread's own (`threadPanelIntent.ts`,
      unchanged rule).
22. **`behind` only held for an open tab.** A new tab went to the daemon with `focus: false`, and the
    daemon keeps a new tab behind only in the focused pane; the editor being typed in can sit in a
    pane the layout does not have focused. open_surface gained `behind` (proto
    `OpenSurfaceOp.behind_tab_id`): a tab the user is working in; a tab landing in the pane showing it
    waits behind it there, anywhere else it shows as usual. The window names the editor's tab
    (`fileEdit.ts editorTabInTheWay`, which no longer guesses the group a new tab lands in: the
    daemon knows) and `openTab`'s `behind` is that tab's id. Op cases:
    `open_surface-rule2-behind-*` (Go) and `open_surface-pane-behind-*` (Go and the mock).
23. **"New linked tabs go to the first pane holding the thread's tabs, not the focused one."** Checked
    against the specification: rule 2 says "a pane holds this thread's linked tabs: add a tab
    there", and with several the daemon ranks them by distance from the thread's pane, ties in layout
    order (place.go `rank`). Neither the specification nor the daemon picks the focused one, so the
    tested result (the request in the focused lower pane) is not the rule, and the seam already does
    what the daemon does (it sends open_surface and lets the daemon place). The test is deleted for
    that reason. Its intent (a request landing in another pane than the editor's shows there) is a
    new test, "landing in another pane than the editor's, it opens as usual", built so the daemon's
    placement lands it away from the editor; it also checks that `behind` holds only in the editor's
    pane.
24. **A reopen bypassed the tab's queue.** `shellOpenTab` sent an open tab's new params with a bare
    `set_tab_params`, while `setTabParams` and `retitleTab` go through the per-tab ordered queue
    (`queueParams`). A save's end, computed from the params before the reopen landed, could land
    after it and drop the newer request. Now every params update of a tab (a reopen, `replaceTab`,
    `setTabParams`, `retitleTab`) goes through the one queue, and a reopen with the same params and
    title sends nothing. The save's end (`fileRequest.ts finish`) also decides on the queue's newest
    params (an updater), not the layout's confirmed ones, so a newer request still on its way stands.

## Found on the way

- `DiffView`'s `go` (a pick, a swap, a commit) reopened its tab through `openDiffInPanel` with params
  built from the render's props. The seam never found the tab (gap 20), so it was an open_surface
  outside the queue. Found now, it is queued, and a filter then a swap in a row each replaced the
  other's params (DiffView "the filter box stays through a source with a shorter list" failed). `go`
  and `keep` are one update now, over the tab's newest params through the queue; neither moves the
  focus (the old open_surface did not either).
- A stored first-load import (legacy_panel.go) of a classic thread-framed diff keeps it as its own
  tab now; the legacy cases pass unchanged.

## For PR 22: where a thread's file request lives

Today a request to edit a file has two halves: the daemon's open_surface carries `edit`, `note`,
`focus` and the asker as `thread`, and the window's `threadPanelIntent.ts` turns the ShowView into
the tab's request: a request id (`askId`, made in the window) and `asker`, and `behind`. When PR 22
retires the ShowView emission, the request should live in the daemon's tab params, written by the
daemon in the same open_surface: the daemon makes the request id (it already knows the asker and the
note), names the params as the window reads them (`asker`, `askId`, `note`, `edit`), and the window
only reads them. Two things stay in the window because only it knows them: which editor has the
keyboard (it sends that as `behind` when the user opens something, and for a thread's request the
daemon can use the focused pane's active tab, which is what the layout already does), and focusing
the editor's line with `--focus`, which can follow the layout's focus. With that, a request made
while no window is open is not lost, and nothing about a request depends on a ShowView arriving after
the layout event. The diff pick (`threadPanelIntent.ts panel.diff`) moves the same way: the daemon
picks the file in the user's tab when its sides list it, which needs the compare call it already
makes.

## Gotchas

- The shell test helper (`src/test/shellLayout.ts tab`) gives tabs fake keys (`<kind>:<id>`). The seam
  computes both keys with the shared function rather than trusting `TabEntry.key`, which the
  identity pins make safe.
- The mock's op cases skip placement rules 2 to 6 (Go's alone); a case meant for both has to use a
  rule the mock ports (here `pane`).
- A heavy vitest run in parallel with another one can time out a long PullRequestSurface test and
  cascade through its file; alone, the file and the whole suite pass.

## Verification

- Go: `TestIdentify` (new rows: a framed diff, a framed and titled one, a diff ignoring filter and
  folds), `TestKindsJSON`, `TestOpCases` (four new open_surface cases), `TestViewOpenIdentity` (a
  side, a note: two tabs), `TestViewOpenDiffKeepsTheUsersTab` (fails with the keep removed).
- vitest: the un-skipped gap tests in `threadPanelIntent`, `filePanel`, `fileRequest`, `prPanel`,
  `prLinks`; `shell/identity.test.ts`; `shell/hostShell.test.ts` (identity lookup, pull request
  spelling, queued reopen, behind); `mock/panelItemVerbs.test.ts` (keepUsersDiff); the mock's op cases.
