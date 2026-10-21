# Frontend robustness (fuzz findings, 2026-10-21)

Fixes for seven findings of a fuzzing pass over the GUI (Playwright WebKit against the mock
daemon, odd items injected into the stores, garbage in localStorage).

## Palette ranking

cmdk sorts items inside a group but cannot reorder groups: its group sort looks up
`[cmdk-group][data-value=…]` and `Command.Group` never renders that attribute. With one
group per category, results came out in category order and Enter ran the first loose
subsequence match ("help" → app.relaunch). With a query the palette now filters itself
(`shouldFilter={false}`) and lists one flat "Results" group from `palette/rank.ts`:
`defaultFilter` (cmdk's commandScore) on the title, 0.9× on the dotted name, 0.5× on the
category, ties to commands with a keybinding, then by title. The empty query keeps the
category groups. Arg prompts still use cmdk's filter.

## Error boundaries

`components/error/ErrorBoundary.tsx` (a class; React has no hook) wraps each timeline row
(`TimelineList`, so the subagent view too), each panel tab body (`GroupBody`), the bottom
panel and the app root (`main.tsx`). A row's fallback is one line plus a shadcn
Collapsible "Details" with the error and the row's items as JSON (`lib/rowItemIds` walks
id/ids/permissionId/children/nodes/latest); it retries when one of those items changes
(a running tool's result may complete what was partial). Panes get "Try again"; the root
gets the error text and Reload.

The payloads that used to throw are handled at the source too: `str`/`num`/`obj` take
`unknown`, and parsed arrays go through `objects()` (non-objects dropped) or `patchHunks()`
(hunks without a `lines` array dropped, missing numbers 0). With those in place the report's
payloads no longer reach the boundary; the e2e (`row-error.spec.ts`) injects a text item
whose text is a number, which react-markdown rejects.

## Streaming markdown

TextRow re-parsed the whole answer per delta. While `streaming`, `StreamingMarkdown`
renders `lib/markdownBlocks` blocks, each a memoized `MarkdownContent` (Markdown without
its wrapper) keyed by index inside one `.cf-markdown cf-streaming` div, so CSS (first/last
child margins, the caret on the last child) sees the same children as a whole render. A cut
is a blank line outside a fence, made only once the next line has begun and starts a new
top-level block: not indented, and not the next item of a list (a loose list stays one
block). Cuts are stable as text grows. Link reference definitions and footnotes resolve
across blocks only in the whole render, which happens once when the stream ends (one full
parse plus a remount of the answer: ~0.5 s for 76 KB in the dev build).

`CodeRunContext` no longer carries the whole text: a finished reply and the finished
blocks get a stable `{ text: "", streaming: false }` (their code is complete), only the
last block's value changes per delta. Ember's chat (`EmberTimeline`) still renders whole;
the same component would serve it.

Dev-build timings (one 200-char delta per frame, median frame by length): before 30 / 56 /
99 / 166 / 218 ms at 10 / 19 / 38 / 57 / 76 KB, 41.6 s for the 380 frames; after 16 / 17 /
16 / 14 / 17 ms, 6.6 s.

## Persisted stores

`stores/persisted.ts` holds the guards; every persisted store has a `merge` that keeps only
its known fields, of the right type: the bottom panel (`sanitizeBottomState`, the crash),
ui (only the partialized fields, numbers finite and clamped; it used to spread the whole
persisted object, so a stored `selection: null` would have been taken too), codeView,
workIn, reviewerRecents and settingsPrefs. `persisted.test.ts` feeds each store null,
arrays, numbers and wrong-typed fields, whole and per field, and then uses it.

## Attachment cache

An LRU over `files` with a 256 MiB budget. `useAttachment` pins its path while mounted
(refcount); eviction skips pinned entries and the entry just loaded, revokes object URLs,
and an unpinned entry moves to the back (it was just on screen). PDF summaries (small) stay.
`stagePath` reads the staged file back with `readAttachmentFile` (uncached): the draft keeps
its own File.

## Relative links

`MarkdownExtras.link` renders hrefs that `isRelativeHref` accepts; the thread's extras turn
one that `linkPath` reads as a path (code strictness; `#L12` / `#L12-L30` anchors are the
line, other anchors and queries dropped, percent-decoded) into a PathChip showing the path,
and any other into plain text. PR bodies keep resolving against github.com. The chip shows
the path, not the link text.

## Daemon unreachable

`isUnreachable` (api/stream.ts): a fetch TypeError (connect-web wraps it as Unknown with the
TypeError as cause) or an Unavailable whose message is empty or a bare `HTTP nnn`. The
daemon's own Unavailable errors carry a message and pass through. `errorMessage` says
"Code Foundry's daemon is not reachable." for them everywhere; the two composer sends use
`sendErrorMessage`, which adds that the message is kept.

## Gotchas

- `src/lib/tooltips.test.ts` flags any `title=` prop on a component, so Markdown's `Link`
  takes `tip`.
- e2e ports: run with `E2E_MOCK_PORT` / `E2E_VITE_PORT` set when another worktree may be
  running e2e. `plugins.spec.ts` "a button click reaches Act" failed once under a full
  4-worker run and passed alone.
