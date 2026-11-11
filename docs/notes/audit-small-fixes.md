# Small fixes after the 2026-11 review

Fifteen small items from the whole-repo review (docs/notes/audit-2026-11.md), one commit each
or per small group.

## Decisions

- **Terminal links** (components/terminal/terminalLinks.ts): a cmd+click is still the only
  gesture that opens a link in a terminal (a plain click selects). A GitHub pull request opens
  as a Pull request tab of the selection's panel, as in a thread's messages; cmd+shift+click
  sends it to the browser instead (the terminal has no plain click to tell the two apart).
  Anything else http(s) goes through view.open.url. The built app's web view drops
  window.open (Wails 3.1.0 has no new-window hook on macOS), so the old default did nothing.
- **gh 502/504**: classified by status before the body's GraphQL errors, so a timeout that
  carries an errors body still shrinks the poll's query.
- **Dictation Session stream**: at each heartbeat, and after the bus dropped events for it,
  the handler asks the store whether the session ended. When it has, what is still buffered
  for the session goes out first, then the end. A level resets the heartbeat, so the check
  runs once levels stop, which they do at the end.
- **workspace.EnsureDirs** makes a managed dir under the manager's lock, only while the
  workspace still exists. The race with Remove could not be forced without a test seam
  (EnsureDirs's own refreshContents waits on the lock Remove holds); the test hammers
  EnsureDirs during Remove as a guard, not as a reproduction.
- **workspace.Within** now uses fsx.Within over the cleaned and resolved paths: case is
  ignored as APFS ignores it, so a root typed in another case inside a project's checkout is
  refused, and ResolveProject finds a project by such a path.
- **Welcome page dictation switch**: on/off follows `cf.on("settings")`
  (`dictation.enabled`); `dictation.status` is read once and again every 2 s only while the
  model downloads. The mock's dictation.status now returns the snapshot as JSON, as the
  daemon does, so the page works against it.
- **GUI build**: the Taskfiles no longer run `go mod tidy` before every build and bindings
  run. gui/ has no go.mod, so it tidied the root module. `make gui-build` left go.mod, go.sum
  and the build's icon files unchanged.
- **One copy each**: Sidebar uses lib/useWidth's useHeight (clientHeight is layout px under
  the page zoom; checked in WebKit at 80, 100 and 125%: it equals the rect over the zoom);
  src/api/timestamp.ts `ms()` replaces the per-file helpers and inline ternaries (the
  dictation, search, settings and retry fields that default to 0 use `ms(t) ?? 0`);
  command.ThreadsWords is the one ThreadsWords (store/plugin already imports command); the
  thread store's lineSplitter and scanLines are claudestream's Splitter and ReadLines. Those
  drop whitespace-only lines, which the tailer never needed: every consumer parses a line as
  JSON.
- **e2e helpers** in fixtures.ts: openHelloDemo, pluginActs, invokeAs, threadCalls,
  setPanelWidth, setZoom (which waits for `data-zoom`, set at start too). gallery.spec keeps
  its own width setter (it writes thread s-1's entry, not the selection's), and
  theme-model-flow its own invoke (it confirms). No assertion changed.
- **Test worlds**: the scripted thread's text lives in mock/threadScript.ts and the model list
  in mock/models.ts, neither importing generated code; mock/thread.ts and mock/settings.ts
  import them, and so do src/test/threadWorld.ts and composerWorld.ts.
- **workspaceDir** takes the caller's context (Create, placeThread, replan's job context).
- **Mock --title**: view.panel.page and view.panel.diff clean the title (lib/plainText
  plainLine) and refuse one over 100 characters with the daemon's message.

## Flaky tests: the causes

- **TestPollTiers**: the FSEvents stream delivers the fixture's own git writes (commit, push,
  set-head), made just before Register, in batches streamLatency apart. A second batch's status
  run landed in the "idle" window. The test now waits until status runs settle before it
  measures. Before: 3 of 6 parallel runs failed (48 tests); after: 48 of 48 passed.
- **TestProjectActivity**: phase three put the archived thread back to live in the snapshot
  without an event while phase two's second list event could still be queued; its late resync
  recorded `live /w/a`. Reproduced exactly (3 in 3000 with -race). The snapshot now stays as
  published.
- **TestDictationAudioLostEndsTheSession**: Listening comes with Start, so the audio stream
  could be dropped before the server's Audio handler had the frame; it then never learned
  the session and never stopped it. The test waits for the frame at the engine. Before: 8 in
  800 runs under load timed out; after: none.
- **inline-html e2e** (not specific to SHOTS; 2 in 125 without it): the first click on a
  card's action raced the page loading and sizing itself while the log keeps its bottom in
  view. Playwright clicks at coordinates, so a layout shift between its check and the click
  missed the button. openHtmlThread now waits for the page's text and its settled height. A
  second flake there, "Frame was detached" from `expect.poll` over `evaluate` on a frame that
  reloads on a theme switch, is now `toHaveCSS`, which retries across the reload.

## Gotchas

- zsh does not split an unquoted `$FILES` into words: `bunx playwright test ${=FILES}`.
- `thread.spec.ts` "reading the answer when the turn ends" failed now and then while the
  machine was busy (4 in 56 runs over an hour, then 24 of 24); nothing here touches that
  layout.
