# Thread search 2: in-thread find (cmd+f)

PR 2 of the thread-search series. A find bar over the thread on screen: the user's
messages, Claude's text and answered questions, counted from the data and painted where
the rows render.

## Commands

- `thread.find` (cmd+f), `thread.find.next` (cmd+g), `thread.find.previous` (cmd+shift+g),
  View category, defined in `internal/command/commands_view_thread_find.go` like
  `file.find`: a ShowView intent each, available on a thread view (`ActiveView ==
  "thread"`, Ember's chat included; not a subagent run's view) and always for the CLI. The
  GUI presents them in the window (`keys/bindings.ts` → `stores/threadFind.ts`
  `presentThreadFind`); the CLI's ShowView reaches every window (`stores/views.ts`).
  cmd+g and cmd+shift+g were free. They stay in the palette (they have chords). The guide's
  size margin moved from 26,750 to 26,800 for the three names (26,759 bytes with them, after
  thread.search from search-3-index) (`internal/guide/topics_test.go`).
- The daemon needs a restart to list them (the GUI has no other change that needs one).

## Focus: who gets cmd+f

- From the thread prompt it works (the prompt yields bound cmd chords, `[data-chord-yield]`).
- From another text field (the PR panel's review box, a settings search) it does nothing:
  `thread.find` is not in `fieldYielded`, so a field keeps its keys.
- In the bar's own field, the three verbs' chords are looked up from the user's bindings
  and handled there (cmd+f selects the query, cmd+g / cmd+shift+g step); Enter and
  shift+Enter step, Escape closes, clears and hands the keyboard back to the prompt
  (`promptFocusSeq`). The bar is `[data-keys-local]`, so no bare-key command fires from it.
- No surface in the side panel has a find of its own today (File, Diff, PR, MCP); an HTML
  page's frame keeps its keys (they never reach the window). Nothing to yield to.

## What is searched (lib/threadFind.ts)

What stays on screen when a turn folds, plus answered questions:

- user messages and steers: the bubble's text pieces (`parseUserMessage`), not its tags
  (files, threads, skills, PRs, citations, attachments); wake messages and resume notes
  are notes, left out;
- every text item of Claude's, as rendered (below), not API-error texts;
- AskUserQuestion items that are not pending: each question then its answer ("—" for none),
  a line each, as the row's expanded detail renders them. The answer counts once: the
  detail is searched, the summary row that repeats the answer is not.
- Never tool calls, output, thinking, permissions, notes, errors, subagent items
  (`parentToolUseId` set).

Smart case (`\p{Lu}` in the query → case-sensitive), plain substring, non-overlapping.
Lower-casing keeps UTF-16 offsets (a letter whose lower case is longer, `İ`, stays as is).
Each item's text and its lower-case form are cached by item identity (items keep identity
while unchanged). A streaming answer is a new item every batch, so it is read the way
StreamingMarkdown draws it: cut into blocks (`lib/markdownBlocks`), each block's text
cached by its source (`streamingMarkdownText`), so a batch parses only the growing last
block (a 26 KB answer: 45 ms a batch before, 0.6 ms now). Only finished blocks are cached:
the last block is parsed each batch and not kept. Caching it kept a copy per batch (a 68 KB
code block streamed in 1000 batches retained 77.7 MB) and pushed finished blocks out of the
2000-entry cache. That is also what the DOM shows
while streaming: a reference link or footnote stays literal until the answer ends and
renders whole (it was counted resolved before, a mismatch). In Ember's chat a streaming
reply's task links count as text, as StreamingMarkdown draws them until the reply ends.

The count is computed once per log and query and shared (`threadFindMatches`): the bar,
the layer and a step read the same array. When the bar opens, the layer reads the thread's
texts ahead in 8 ms idle slices (`warmFind`; a timer slice in WebKit, which has no
`requestIdleCallback`), so the first keystroke does not parse every answer (500 answers
cold took about 2.7 s in the bar's render). A bar opened before the log loads starts the
warm-up when the log arrives (it used to run once over no items and stop).

## Rendered text without a DOM (lib/markdownText.ts)

The count must equal what the DOM shows, so the k-th match in the data is the k-th match
in the row's DOM text. `markdownText` runs the renderer's parse and walks the hast tree the
way `citeDom.plainText` walks the DOM: text nodes in order, a newline when the block
changes, whitespace between blocks dropped. The parse's plugin lists live in
`lib/markdownPlugins` and both `components/pr/Markdown` and `markdownText` use them
(remark-parse, GFM, remark-rehype with raw HTML kept, `rehypeInlineHtml`, the sanitizer,
the prose path pass), so a plugin added to the renderer is in find's text too. They moved
to lib rather than being exported from the component, so lib does not import a component.
It reads the tree as the thread's components draw it: a fenced block's code without its
last newline, an inline code span, relative link or prose token that is a path as the
chip's text, images and task-list checkboxes as nothing. `unified`, `remark-parse` and
`remark-rehype` became direct dependencies at the versions react-markdown already pulled
in (bun's isolated install does not expose transitive ones); no bundle growth.
`lib/markdownDeps.test.ts` fails when package.json pins a version other than the one
react-markdown resolves in bun's store (`node_modules/.bun/react-markdown@*/node_modules`),
so a react-markdown bump cannot ship two copies.

`markdownText.test.tsx` renders `ThreadMarkdown` and `StreamingMarkdown` in jsdom for
sixteen shapes (paragraphs, lists, loose lists, code, tables, headings, quotes, links, path
chips in code and prose, inline HTML, task lists, breaks, images, an unloaded local image,
a reference link, a footnote) and compares with find's DOM text (`findText`). In the browser, every rendered item
of the mock threads (the thread and Ember's chat) compared equal.

Ember's chat draws `[Title](cf-task://…)` lines as pointer rows, not text: the data drops
them too (`answerText`, Ember's own `splitTaskLinks`). In an ordinary thread such a line
would render as text and not count; only Ember writes them.

A local image that has not loaded shows a chip with its alt text (or "Loading image…");
the data counts no text for images. The chip is `data-find-skip`, in find's skip selector,
so its text is neither matched nor shifts the later matches' order in the item.

## Painting and the DOM (components/thread/find)

- Elements carry `data-find-item=<item id>`: TextRow's answer element, the user bubble
  (`UserBubble findItem`, the tags skipped by selector), the question row's expanded `dl`.
- `paintMatches` matches each rendered item's text again (`plainText` with the skip
  selector) and paints every match with `::highlight(cf-find)` (warning 26%), the current
  one with `::highlight(cf-find-current)` (solid warning, warning-foreground), through the
  cite layer's `paintAll` (new, many ranges per highlight), whose overlay is the fallback
  (the overlay's current box is 60% warning, not solid: it sits over the text).
- The layer repaints one frame after a mutation in the list (rows mounting, text
  streaming) or a resize; on scroll only for the overlay fallback (no Custom Highlights):
  a highlight moves with its text, and a tick's place is in the list's own coordinates.
- Counts come from the data only; painting never counts.

## Navigation

- The current match is a key, `{ itemId, nth }`, so text streaming after it does not move
  it. When its item no longer has that match (text changed under it), the nearest match in
  the same item to where it was becomes current, in place (no scroll: `setThreadFindCurrent`
  `reveal: false`); when the item has none left, the first match after it, revealed.
- Picking (the layer, `aim`): opening or typing on an empty session takes the first match
  at or after the top row of the list (the row's item by log order, `rowOrder`); editing
  the query goes on from the current match, its item and its start offset (`aim.from`:
  the first match at or after that place, as a browser's find does, so typing neither
  jumps back to the top nor to the first match of a long answer); a hand-off's item
  (below) takes that item's first match. Nothing is picked before the thread's log has
  loaded: the aim waits for it (a hand-off to a thread not yet cached). A hand-off's item
  missing from a log kept from an earlier visit (`KEPT_LOGS`) also waits, until the
  thread's Watch delivers its first snapshot since it opened (`synced` in the thread
  store, set by `applyWatchBatch` on a snapshot, cleared when the Watch ends): the search
  that named the item read the daemon's index, newer than the kept log, which gave "0 of
  1" with nothing current. A store field, not a module flag, because a snapshot equal to
  the kept log changes no log and would re-render nothing.
- The anchor: each edit of the query records where it went on from (`anchor`, the then
  current match's item and offset), and it outlives a null current. An edit through "no
  match" (at 21 of 29 a letter makes it 0 of 0, Backspace) goes on from the anchor
  (`s.current ?? s.anchor`) and lands on 21 again, not 1. A hand-off with a query drops it.
- Matches that arrive later (a query with none, then text streaming in or a log catching
  up: "0 of N"): when there is no current match and the count goes from 0 to more, the
  first match at or below the top of the list becomes current, in place (no scroll).
- Bringing it into view (`revealMatch`): the list unpins (stops following the bottom);
  a row already rendered is placed by its match's lines (cite `scrollToQuote`: the middle
  of the visible part, between the list's top and the composer's top, unless already in
  view), else the row is scrolled in first (`showRow`), then placed. Where the bar lies
  over the lines (the card closed or floating), the visible part starts under the bar
  (`visibleTop`); beside an inline card the bar is over the card's column and does not count.
- Live threads: the count follows streaming text; nothing scrolls unless the current match
  changes.

## Folded questions: open and put back

An answered question is a step row inside the fold; its text is in its expanded detail.
When the current match is in it, `openThreadFindItem` (stores/threadFind) expands the row
(`setRowExpanded`) and asks the timeline to unfold what hides it
(`TimelineHandle.unfold`): the thread's timeline now has one (`foldingTurn` in
lib/threadTimeline: the turn whose fold hides a question or tool row; a text is never
hidden), Ember's opens the work row. It records each choice it changed as `{ before, set }`
in the find session (`opened`) and, when the current match moves to another item, the
query finds nothing or the bar closes, puts those back (`putTurnView`: a choice that was
the default is dropped again). Putting back the last item's and opening the next one
happen in one tick and are read from the store, not the rows on screen, so a turn both
need is never folded and unfolded on screen. While a new query waits for its first match,
nothing is put back yet (the same question again would flicker).

A change the user makes to any choice find opened for the current item, while the bar is
open, makes the whole item theirs (decided): a watch on the thread store sees any change
away from a value find set (collapsing the row and expanding it again counts: comparing
values at put-back time alone would miss it) and empties that item's `opened`, so nothing
of it is put back, the turn's fold included (else the turn re-folded over the question the
user had just re-expanded). The item stays recorded, so find opens nothing again for it. A
put-back writes a choice only while the store still holds `set`.

`closeThreadFind` puts back synchronously, from the session. Leaving the thread is
`holdThreadPane` (stores/threadFind), held by WatchedThread's effect: when the last holder
releases, a tick later and only if no view holds the thread again, it closes the find, then
forgets the fold choices. The tick is for StrictMode (main.tsx), which in dev builds,
the e2e build included, runs an effect's cleanup and the effect again on mount: closing in
the cleanup itself wiped a hand-off made before the row click. The layer's own unmount puts
back what the still-open session holds, so by the deferred close there is nothing left to
put back (the layer used to put back from a ref after the choices were forgotten, writing
them again). A visit to a subagent run unmounts the layer with the session open: what it
opened goes back and opens again on return.

In vitest, an inline `<StrictMode>` element does not replay effects under RTL 16 and React
19.3; `render(…, { reactStrictMode: true })` does (the StrictMode test uses it).

## Layout

- The bar sits in the timeline's pinned layer (the card's layer), `top-3`, the card's x and
  width; the card (and the floating overlay on a narrow pane) moves down by `--ti-find`
  (`--ti-find-open`, 46px: the 38px bar and an 8px gap), set on the pane body while the bar
  is open. Card closed or not fitting: the bar takes the same spot (308px wide, the
  overlay's width, when the card does not fit). The "catching up" pill moves down with it.
- Bar: `bg-cf-surface-overlay` (the design guard refuses `bg-popover`), `rounded-lg`,
  `shadow-2xl`; input `text-body-sm`; count `text-caption` muted, "n of m" ("0 of 0" for no
  match, hidden for no query); "Aa" (`text-caption-sm`, accent surface) only while
  case-sensitive, its tooltip says why; three 22px icon buttons with name tooltips, up and
  down dimmed (aria-disabled, not disabled, so a press keeps the field focused) until there
  is a match.
- Match map: absolutely placed in the pane body over the scrollbar's edge (6px wide,
  pointer-transparent), a 3px tick per spot, the current one solid. A painted match's tick
  is at its text; any other at its row's offset (`TimelineHandle.rowStart`, measured or
  estimated), and a folded question at the nearest row before it in log order
  (`matchRows`). Ticks closer than a quarter percent share one.

## Hand-off API for PR 4

```ts
import { openThreadFind } from "@/stores/threadFind";
openThreadFind(threadId, query, { itemId });
```

Opens (or refocuses) that thread's bar with `query` and makes the first match in `itemId`
current once the thread's layer has the matches, which waits for the thread's log when it
is not loaded yet (falls back to the first match at or below the top of the list when the
item has none). The thread must be the one in the content
pane for the bar to show; call it before or after selecting the thread (the session lives
by thread id until the thread leaves the content pane; StrictMode's replay is not a leave).
An item missing from a log kept from an earlier visit waits for the thread's snapshot. `openThreadFind(threadId)` without
a query opens the bar keeping what it had. Other exports: `closeThreadFind`,
`stepThreadFind`, `setThreadFindQuery`, and `lib/threadFind` `findMatches(items, query)`
for counting a thread's matches from its items.

## Tests

- vitest: `lib/threadFind.test.ts` (smart case, substring rules, which kinds count, question
  counted once, Ember task lines, streaming recount and block-by-block text, warm slices,
  step/start (offset)/nearest/count, match map rows), `lib/markdownText.test.tsx` (data
  text = rendered text, whole and streaming), `lib/markdownDeps.test.ts` (one copy of the
  parse packages), `stores/threadFind.test.ts` (session, typing on from the match's offset,
  shared count, steps, presenter), `stores/threadFindFolds.test.ts` (open and put back
  folds and expansions, a user change taking the whole item, close then forget leaves nothing),
  `find/FindLayer.test.tsx` (a hand-off before the log loads, against a stale kept log, with
  a missing item, through StrictMode's replay; picks from the top, an edit through no
  match, matches arriving later, the warm-up once the log arrives, a stale current match
  staying in its item or moving on, leaving the thread, closing), `stores/thread.test.ts`
  (`synced`), `lib/markdownText.test.tsx` (the block cache does not grow with batches),
  `find/FindBar.test.tsx` (count, Aa, keys, close), `cite/reveal.test.ts` (the bar's area
  not visible), `ember/EmberTimeline.test.tsx` (a work row opened and put back),
  `lib/threadTimeline.test.ts` (`foldingTurn`), Go `commands_view_thread_find_test.go`.
- WebKit e2e `e2e/thread-find.spec.ts`: cmd+f from the prompt and the bar beside the card,
  painted ranges and the map, scroll to an off-screen match and unpin, the current tick at
  its text before and after a wheel scroll, a folded question unfolding, moving on and
  Escape putting it back, a hand-off (`openThreadFind` through `__cfModule`) before the row
  click surviving StrictMode.
