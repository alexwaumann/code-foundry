# Thread info card: the Context and Usage rows

Status: done on branch `cf/thread-info-usage-rows` (GUI only). A polish of the card's last
group (`components/threadinfo/ContextGroup.tsx`) after using it on live threads, plus the
row tint of open folds (`Row.tsx`). The card's layout is a sibling PR
(`cf/thread-info-scroll`); this one touches no layout file.

## Decisions

* **Context row**: the text is just "Context". The value column holds, left to right, the
  muted "cache 41m" (`ti-context-cache`) while the prompt cache is warm, then the 56px bar
  and the share when the window is known. No " · " separators. Nothing before the first
  result, and nothing once the cache has expired: the composer's ColdCacheNote already says
  "Cache expired", so `cacheSuffix` returns "" for null and for 0 or fewer minutes.
* **Context hover card**: "221K of 1M tokens used" (or "N tokens used" without a window);
  while warm also "Cache expires in 41 min" and, when `contextRereadUsd` > 0, "$2.21 to
  re-read it after that". The old "N cached" and "Cache expired: the next message re-reads
  it for $X" lines are gone; an expired or missing cache adds nothing.
* **Usage row**: the text is "Usage" and the value the total cost, muted. The token count
  left the row: users read it as their context. It is the fold's Total now.
* **By model hover card**: one grid (`grid-cols-[minmax(0,1fr)_auto_auto]`, nowrap,
  tabular-nums) of label, cost and share, so the share can no longer wrap under the cost (it
  did in the live app with a long cost). The label truncates instead.
* **The fold**: Input, Output, Cache read, Cache write (tokens, cost), then Total (tokens and
  cost in the text colour, `ti-usage-total`), then "Saved by cache reads"
  (`ti-usage-saved`, `text-cf-success-text`): the sum of the buckets' `cacheSavingsUsd`
  (the Usage page's figure), memoised with the totals, hidden under half a cent. Then
  Requests. Savings are in the fold only, not the hover card.
* **Costs are cents on the card** (`lib/threadInfo`: `USD_SHOWN` = 0.005, `cardUsd`,
  `foldUsd`). A total under half a cent reads "<$0.01" (the row, Total, a model, the
  re-read); a token kind under half a cent shows no cost (an empty cell); unpriced stays "—"
  ("unpriced" on the row). `lib/usage`'s `fmtUsd` is unchanged: the Usage sheet relies on
  its four decimals under a cent. The mockup used `fmtUsd` above the threshold, which still
  gave "$0.0070" between half a cent and a cent; the card's own `cents` formatter rounds
  that to "$0.01".
* **An open fold is not selected**: only a menu trigger (a `Row` with `aria-haspopup`) keeps
  `aria-expanded:bg-cf-control-hover` while its menu is up. Folds (Usage, Changes, Previous
  agents, shells) show only the down chevron while open; a tinted fold read as a selection.

## Tests

* `lib/threadInfo.test.ts`: `cacheSuffix` is "" once expired; a table of `cardUsd` and
  `foldUsd` over 0, a sliver, 0.004, 0.005, 0.07 and thousands, and unpriced kinds.
* `e2e/thread-info.spec.ts`: the single-project case checks the row texts, the right-hand
  values, the hover lines, model costs and shares on one line, the fold's kinds, Total
  (equal to the row's cost) and Saved, and that an open Usage fold has a closed row's
  background with the pointer elsewhere. New cases: an expired cache
  (`/__mock/thread/cache?ago=3700`: no suffix, the hover card has only the tokens line) and
  a thread under a cent (Haiku usage on s-2: "<$0.01", empty kind costs, no Saved row).

## Gotchas

* `Row`'s `meta` drops `false`: the context row passes `(suffix || pct !== null) && …` so a
  thread with neither leaves the value column out rather than rendering an empty span.
* The fold's rows are `display: contents` wrappers (test ids only); assert on their spans,
  not their boxes. The model rows' cost and share spans carry
  `ti-usage-model-cost`/`-share` for the one-line check.
