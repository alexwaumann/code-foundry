# Pull request page: the Diff button and the ⋯ menu's final order

The slice of the pull request page redesign (sketch v11) that wires the earlier pieces into the
page: the Code tab goes, a Diff button opens the diff tab (#804), and the ⋯ menu gets Close,
Reopen (#802), Copy branch name and a Link to thread submenu. Frontend only.

## What shipped

- **Inner tab row**: Overview | Activity. At its right end, alone, the Diff button
  (`components/pr/DiffButton.tsx`): the file-diff icon, "Diff", "3 files" (muted) and
  "+1,420 −142" in the success and failure tones (`toneText`), GitHub's counts from the
  detail. It is the page's only diffstat. Under 480px of surface the file count goes, under
  360px the counts too (container queries on the surface, as the header uses). "Updating…"
  keeps its behaviour and sits left of it. Activity's counts and order toggle follow the tabs
  on the left. While the detail is on its way the button shows "Diff" with no counts and works.
- **The press** calls `openPullRequestDiff(ref, target)`, with the surface's target (the
  selection's, "current" without one): the diff tab opens in the pull request's pane after its
  tab, and a second press shows the tab already open.
- **Code tab removed**: `PrCode.tsx`, `PrCode.test.tsx` and `e2e/pr-code.spec.ts` deleted (the
  diff tab's tests cover the viewer since #804), with the `files` section of `PrSection` that
  only it used. `PrInnerTab` is `"overview" | "activity"`; `innerTabOf` reads a tab's state, so
  a tab left on "code" (or anything unknown) shows Overview.
- **⋯ menu** (`PrMenu.tsx`): Start a thread (Ask a question, Explain this PR, Fix findings);
  This pull request (Convert to draft when allowed, Close pull request when
  `canClosePullRequest`, Reopen pull request when `canReopenPullRequest`, Link to thread);
  Open on GitHub, Copy link with its chord, Copy branch name; Refresh with its freshness. The
  "This pull request" heading is always there now (Link to thread always is).
- **Busy states** as Convert to draft's: the item spins with "Closing…" / "Reopening…" and is
  aria-disabled, the menu stays open until the detail shows the result (`prClose.ts` keeps
  `closing` until the re-read lands), and the ⋯ button spins when the menu was closed first.
  Close runs `pr.close`, whose confirmation is the daemon's; declining leaves the menu as it
  was. Success toasts stay (`closePullRequest` without `inView`), as #802's note planned.
- **Link to thread** replaces Link to this thread (and `useLinkableThread`): a submenu headed
  "Threads open in this space" listing the threads with a tab in the current space (the
  shell's layout via `spaceTabs`, panes' order, each once, preview tabs included), each by
  name, ticked when its linked pull requests include this one (any case of the slug). Picking
  an unticked thread runs `thread.pr.link` (`linkPullRequestToThread`); the row spins until the
  thread published by the daemon lists the link, then the menu closes. A failure frees the row.
  With no thread tab in the space the row is muted and the submenu says "No threads open in
  this space".

## Decisions

- **Ticked rows are inert.** There is no unlink command (`commands_thread_prlink.go`: "There is
  no unlink"), and this slice adds none. A ticked row is aria-disabled with a hidden "Linked".
- **The submenu unfolds inline**, under its row, as the sketch draws it (chevron turned, a
  left rule, the heading and the rows indented), not as a Radix flyout. Tried first as a
  flyout: with the pull request in a pane at the window's right edge the flyout flipped left
  over the sidebar, outside the pane every other popup of the page stays in. Inline it never
  leaves the menu. Keyboard: Enter or ArrowRight on the row unfolds, ArrowLeft folds (from a
  thread row too, focus going back to the row). The rows are ordinary menu items, so the
  menu's arrow keys walk through them.
- **The muted no-threads row still unfolds**: the brief asks for both a disabled row and a
  submenu that says why; a Radix-disabled item could not open, so the row is aria-disabled
  and muted but takes the press.
- **Waiting for the tick, not the command.** The command answers before the thread's update
  arrives on the stream; closing on the answer would close before the result is on screen.
  The wait is a store subscription started from the answer (`whenLinked`), cancelled if the
  menu closes first; a `useEffect` that set state on the tick tripped the lint rule.
- **The diff is still read ahead of the button.** `useDiffWarm` stays: once the detail is
  current, after a 600ms pause and behind any detail read, and not while prefetching is held,
  the page reads the diff, so the diff tab the button opens shows its files at once instead of
  a skeleton. It costs one read per pull request opened (the daemon's cache answers repeats
  for the same head), the same cost the Code tab already had; the button is now the page's
  only way to the diff, so it is the read most likely to be wanted next.
- **Activity's counts go under 640px** (they went under 400px before the button). Measured in
  WebKit: tabs 148px, counts 123px, toggle 101px (24px as an icon), Diff 178px, 137px without
  the file count, 52px alone. Tabs, counts, toggle and the full button need about 610px.
- **"Updating…" no longer clips** with `overflow-hidden` on its box: the box holds only it and
  the button, and the text truncates itself.

## Differences from the sketch (v11)

- Activity keeps its counts and order toggle in the row (the sketch's Activity shows none);
  they sit after the tabs and give way first, so the Diff button stays alone at the right.

## Gotchas

- `@max-[480px]` is `width < 480px` of the surface, which is the pane's width minus its 2px
  border: `sizePane(…, 480)` gives a 478px surface. The e2e test sizes the pane 2px over each
  threshold.
- jsdom evaluates no container query: the vitest test checks the hiding classes, the e2e test
  the visibility.
