# Phase 4, the page library: test-round fixes, routing, labels, Escape, card anchoring (2026-10-26)

Fixes from the page library's test round (after #364). The tester's numbers are used below.
A parallel PR has the library, CSS, loader and skill-reference findings.

## What each finding became

- **5, routing in a project thread.** Four of nine page prompts loaded no pages skill.
  They wrote the page into the repository with `localStorage` and no theme, and some
  hand-posted `cf:resize` because the warning told them to. The cause was the always-on
  prompt line: it handed out `view.inline` without the skill or the folder.
  - `ThreadPrompt`'s page clause is now "a page, mockup, chart or form to fill in is an
    .html file in $CODE_FOUNDRY_PAGES, not the repo unless asked (skill
    code-foundry-pages first), shown with view.inline <file>, not markdown". That is
    **92 bytes** more, 1549 → 1641. The cap in `prompt_test.go` moved by exactly that, from
    1550 to 1641. The test's "one static line" check allows the one `$`: it is the
    folder's variable, which the model expands in its shell.
  - `WarnNoResize` now says the page does not load `/cf/bridge.js` and gives the script
    tag "(it sizes the card)", then names the pages skill. It no longer gives the
    hand-written `cf:resize` workaround. Its condition is unchanged.
  - The same steer was in three more places. They now say the bridge sizes the card:
    - the entry skill's Showing things line;
    - the help skill's theme paragraph;
    - the rendering capability's `view.inline` sentence.

    The skills tests and the capabilities test pin the new wording.
- **11, thread.label.** The store now does what the help said: clear, then remove, then
  add. A label in both remove and add ends up on the thread, which is how a page's kanban
  moves a card (remove every column's label, add the new one). The proto comment says
  so; the help's own words were already right and stay as they were (the guide is at its
  25,500-byte topic-split limit). `TestEditLabels` has the move as a table case. The API test moves a card
  between columns where it used to expect INVALID_ARGUMENT. Checked through the daemon
  and CLI: `thread.label --id … kanban/review --remove kanban/todo,kanban/review,kanban/done`
  leaves `kanban/review`.
- **12, Escape inside a frame.**
  - **The page side.** `bridge.js` posts `{type: "cf:key", key: "Escape", cf: 1, nonce}`
    for a keydown Escape that nothing in the page consumed. That means the default was not
    prevented (Radix overlays prevent it when they close), the key was not composing (IME)
    and was not a repeat. The listener is on the window in the bubble phase, so every
    handler in the page runs first.
  - **Its own block.** The handler is a separate small IIFE at the end of `bridge.js`. It
    reads the nonce from the fragment itself and has its own double-load guard
    (`window.__cfKeys`), so it stays clear of the bridge's resize measurement, which the
    other PR edits.
  - **The host side.** `HtmlFrame` has an `onKey` prop. It fires only for this frame's own
    window and origin, and only with the frame's nonce (no nonce or another nonce is
    ignored). Only the lightbox's frame passes `onKey={close}`. The card's frame has none,
    so Escape in a card never closes or navigates anything. `TestScriptNamesTheContract`
    pins `"cf:key"`.
- **14, cards jumping as they shrink.** When a page card's frame asks for a new height
  while the pointer is over the frame (`:hover`) or the frame has focus, and the height it
  gets really changes, the card calls `HoldTopContext` (from `TimelineList`) with itself
  first. For the next 400 ms the timeline puts the card's top back where it was
  (`restoreHeld`) instead of following the bottom. This happens in the content's resize
  observer, in the rows-changed layout effect and on a scroll nobody asked for (the
  browser clamping a shorter list).
  - **The spacer.** When the card was at the bottom and shrank, the list is too short to
    keep the top. A spacer div under the rows makes up the difference
    (`lib/timelineHold.ts` `heldScroll`, which measures the rows' own height, so it also
    works when the rows are shorter than the box).
  - **When the spacer goes.** Rows growing later fill the spacer
    (`spacerAfterGrowth`), so the rows' end does not jump. Jump to bottom clears it, and
    the user's own scroll ends a hold.
  - **Tests.** `timelineHold.test.ts` is a table test of the arithmetic. A Playwright case
    in `bridge.spec.ts` shows both sides: with the pointer elsewhere, a shrink still moves
    the card down (the timeline keeps its bottom); with a click in the page, the card's
    top stays within 2 px.

## Routing A/B (item 5)

Setup:
- the daemon built from each wording, under an isolated `CODE_FOUNDRY_HOME`;
- two scratch git repositories under `$HOME` as projects (README only);
- fresh project threads (the project's own checkout) on `claude-sonnet-5-5[1m]` at medium
  effort;
- one prompt each. The five prompts of a rep ran at once in the same repository, which
  was cleaned between reps.

"Routed" means the thread loaded the code-foundry-pages skill and wrote the page in
`$CODE_FOUNDRY_PAGES`. Both always went together.

| Prompt | before (main) | after (shipped wording) |
|---|---|---|
| a settings page with a slider for font size and a dark/light toggle | 0/3; repo + localStorage 3/3 | 2/4; the 2 misses: repo + localStorage |
| mock up a login screen for an invented fintech app | 1/3 | 4/4 |
| make a small calculator | 0/3; calculator.html in the repo 3/3 | 0/4; calculator.html in the repo, not shown |
| make me a page where I can jot quick notes: a button opens a dialog to add a note, and the notes show in a list | 0/3; repo + localStorage 3/3 | 4/4, all with /cf/theme.css + /cf/bridge.js |
| make me a page with a slider for font size | 0/3; repo + localStorage 3/3, hand-posted cf:resize 2/3 | 4/4 |
| **total** | **1/15** | **14/20** |

After the change, no page hand-posted `cf:resize` and no routed page used `localStorage`.

The wordings tried, with the five prompts each time:

| Wording of the clause (after "a page, …") | Bytes over main | Routed |
|---|---|---|
| "a page, mockup, chart or form to fill in is an .html file in $CODE_FOUNDRY_PAGES (skill code-foundry-pages first) shown with view.inline <file>, not markdown" | 64 | 9/15 (settings 0/3, calculator 0/3) |
| "a page, mockup, chart, form or small tool for the user (not code the project ships) is …" | 107 | 6/10 |
| **shipped**: "… in $CODE_FOUNDRY_PAGES, not the repo unless asked (skill code-foundry-pages first), shown with …" | 92 | 14/20 (settings 2/4) |
| "a page, chart or form to fill in is .html, not markdown; any .html you make goes in $CODE_FOUNDRY_PAGES, not the repo unless asked (…)" | 101 | 7/10 (the calculator became calc.py) |

The shipped wording is the smallest one that routed the settings page at all.

**Not routed: "make a small calculator".** In a project thread the model reads it as code
for the project: calculator.html in the repository, or calc.py with the 101-byte wording.
It never treats it as a page. That reading is fair in a repository, so the clause was not
grown further for it.

## Gotchas

- `code-foundry help <verb>` with `CODE_FOUNDRY_HOME` set starts a daemon for that home (the
  help reads settings defaults). Stop it before starting your own daemon on the same home.
- `thread.new --json` prints the thread itself, not `{thread: …}`.
- Two e2e runs in parallel worktrees collide on the mock's ports: `E2E_MOCK_PORT` and
  `E2E_VITE_PORT` move them.
- An iframe element matches `:hover` in the parent document while the pointer is inside
  the frame (WebKit), which is how the card knows the pointer is in its page.
