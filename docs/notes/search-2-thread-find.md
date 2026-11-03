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
  size margin moved from 25,650 to 25,750 for the three names (`internal/guide/topics_test.go`).
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
while unchanged), so a streaming answer re-reads only itself.

## Rendered text without a DOM (lib/markdownText.ts)

The count must equal what the DOM shows, so the k-th match in the data is the k-th match
in the row's DOM text. `markdownText` runs the renderer's parse (remark-parse, GFM,
remark-rehype with raw HTML kept, `rehypeInlineHtml`) and walks the hast tree the way
`citeDom.plainText` walks the DOM: text nodes in order, a newline when the block changes,
whitespace between blocks dropped. It reads the tree as the thread's components draw it:
a fenced block's code without its last newline, an inline code span or relative link that
is a path as the chip's text, images and task-list checkboxes as nothing. The sanitizer and
the prose path pass change no text, so they are left out. `unified`, `remark-parse` and
`remark-rehype` became direct dependencies at the versions react-markdown already pulled
in (bun's isolated install does not expose transitive ones); no bundle growth.

`markdownText.test.tsx` renders `ThreadMarkdown` in jsdom for a dozen shapes (paragraphs,
lists, loose lists, code, tables, headings, quotes, links, path chips, inline HTML, task
lists, breaks, images) and compares with `plainText`. In the browser, every rendered item
of the mock threads (the thread and Ember's chat) compared equal.

Ember's chat draws `[Title](cf-task://…)` lines as pointer rows, not text: the data drops
them too (`answerText`, Ember's own `splitTaskLinks`). In an ordinary thread such a line
would render as text and not count; only Ember writes them.

A local image that has not loaded shows a chip with its alt text; the data counts no text
for images. A match there is painted but not counted. Accepted.

## Painting and the DOM (components/thread/find)

- Elements carry `data-find-item=<item id>`: TextRow's answer element, the user bubble
  (`UserBubble findItem`, the tags skipped by selector), the question row's expanded `dl`.
- `paintMatches` matches each rendered item's text again (`plainText` with the skip
  selector) and paints every match with `::highlight(cf-find)` (warning 26%), the current
  one with `::highlight(cf-find-current)` (solid warning, warning-foreground), through the
  cite layer's `paintAll` (new, many ranges per highlight), whose overlay is the fallback
  (the overlay's current box is 60% warning, not solid: it sits over the text).
- The layer repaints one frame after a mutation in the list (rows mounting, text
  streaming), a resize or a scroll.
- Counts come from the data only; painting never counts.

## Navigation

- The current match is a key, `{ itemId, nth }`, so text streaming after it does not move
  it. When its item no longer has that match it is picked again.
- Picking (the layer, `aim`): opening or typing on an empty session takes the first match
  at or after the top row of the list (the row's item by log order, `rowOrder`); editing
  the query goes on from the current match's item (as a browser's find does, so typing
  does not jump back to the top after the first letter scrolled); a hand-off's item
  (below) takes that item's first match.
- Bringing it into view (`revealMatch`): the list unpins (stops following the bottom);
  a row already rendered is placed by its match's lines (cite `scrollToQuote`: the middle
  of the visible part, between the list's top and the composer's top, unless already in
  view), else the row is scrolled in first (`showRow`), then placed.
- Live threads: the count follows streaming text; nothing scrolls unless the current match
  changes.

## Folded questions: open and put back

An answered question is a step row inside the fold; its text is in its expanded detail.
When the current match is in it, `openFor` expands the row (`setRowExpanded`) and asks the
timeline to unfold what hides it (`TimelineHandle.unfold`): the thread's timeline now has
one (`foldingTurn` in lib/threadTimeline: the turn whose fold hides a question or tool
row; a text is never hidden), Ember's already opened the work row. It records the choices
it changed with their values before (`getTurnView` diff) and, when the current match moves
to another item or the bar closes, puts exactly those back (`putTurnView`: a choice that
was the default is dropped again). Putting back the last item's and opening the next one
happen in one tick and are read from the store, not the rows on screen, so a turn both
need is never folded and unfolded on screen. While a new query waits for its first match,
nothing is put back yet (the same question again would flicker). Leaving the thread closes
its find first (WatchedThread), then forgets its fold choices as before.

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
current once the thread's layer has the matches (falls back to the first match at or below
the top of the list when the item has none). The thread must be the one in the content
pane for the bar to show; call it before or after selecting the thread (the session lives
by thread id until the thread leaves the content pane). `openThreadFind(threadId)` without
a query opens the bar keeping what it had. Other exports: `closeThreadFind`,
`stepThreadFind`, `setThreadFindQuery`, and `lib/threadFind` `findMatches(items, query)`
for counting a thread's matches from its items.

## Tests

- vitest: `lib/threadFind.test.ts` (smart case, substring rules, which kinds count, question
  counted once, Ember task lines, streaming recount, step/start/count, match map rows),
  `lib/markdownText.test.tsx` (data text = rendered text), `stores/threadFind.test.ts`
  (session, from-item typing, steps, presenter), `find/findDom.test.ts` (open and put back
  folds and expansions), `find/FindBar.test.tsx` (count, Aa, keys, close),
  `lib/threadTimeline.test.ts` (`foldingTurn`), Go `commands_view_thread_find_test.go`.
- WebKit e2e `e2e/thread-find.spec.ts`: cmd+f from the prompt and the bar beside the card,
  painted ranges and the map, scroll to an off-screen match and unpin, a folded question
  unfolding, moving on and Escape putting it back.
