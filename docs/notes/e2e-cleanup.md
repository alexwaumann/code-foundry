# e2e cleanup: useless tests out

After `e2e-parallel-webkit.md` cut the run to 8 to 11 minutes, four reviewers read every
spec against six criteria and four Opus agents acted on the flags, one file group each,
with judgment (a flag was a claim to verify, not an order). Cases drop from 523 to 458 (434 run,
24 SHOTS-only); a full run went from 8.3 to 7.7 minutes with 0 failures. The files that set
the wall time (pr-panel, panel, thread) shrank most.

## Criteria, and what went

* **Light-scheme iterations that assert no colour.** 17 files wrap tests in a dark/light
  loop. Where the light pass asserted nothing theme-specific, it now runs only under
  `SHOTS` (`const schemes = process.env.SHOTS ? ["dark", "light"] : ["dark"]`), so the
  light screenshots still come out of the same tests. Kept in light: the pending-permission
  dock (compares the per-theme waiting colour), and anything that reads a token.
* **Dead tombstones.** Tests guarding things that cannot happen: Close/Reconnect buttons
  (commands removed in #105-#114), footer chord hints, a bare Interrupt key, a member
  worktree under a project row the sidebar no longer has, Chromium key-timing workarounds,
  and three "a daemon older than X" tests (GUI and daemon always ship as one version; the
  hint code in src stays).
* **Strict duplicates.** Deleted when a subset of another test; when one assertion was
  unique it moved into the covering test (the notes in each file say where).
* **Unit-covered.** Deleted only where the e2e added no interaction a vitest test lacks
  (string tables in retryNote, coldCache, completion, lineage; VolumeEditor; BrowseSection
  pills; SidePanel tab moves and Escape-mid-drag). Trimmed to the interaction elsewhere.
* **Pixel trivia.** Radii, computed font strings, exact gaps and heights, equal widths,
  localStorage key shapes: cut from otherwise good tests.
* **Sleeps.** The 5.5 s no-auto-dismiss wait (close the toast instead), the 8 s mock-clock
  settle in the badge test, the 12 s pending-focus expiry (intents.test.ts covers it), a
  1.3 s post-Escape wait (waitForResponse), two 700 ms no-tooltip waits (one kept), the
  800 ms no-tooltip check on the subagent request.

Kept against a flag: the running-threads spinner test's 2 s delay (800 ms fails 3/3: the
ask must still be running after a page switch and typing); the plugin-folder wording test
(nothing else checks the daemon's real plugin home reaches Settings); the help overlay's
real scroll and cmd+/; the project kind tooltips.

## Gotchas

* Concurrent Playwright runs in one checkout must pass `--output=<own dir>`: a run clears
  `test-results/` and the others fail with ENOENT on their traces.
* dnd-kit swallows clicks for 50 ms after a drop; the picking-Escape case enters picking
  through the CLI's new-tab instead.
* Load average over 30 (four agents' runs at once) produced timing failures in untouched
  tests; all passed alone.
