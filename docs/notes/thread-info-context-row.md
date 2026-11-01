# Thread info card: the Context row's layout

Status: done on branch `fix/thread-info-context-labels` (GUI only). Supersedes the Context
row bullets of `thread-info-usage-rows.md`.

## Decisions

* **Left side**: "Context" then, while the prompt cache is warm, the muted "cached for 41m"
  (`cacheSuffix`), separated by a space only (`ti-context-label`, `ti-context-cache`).
  An expired cache still shows nothing (the composer's ColdCacheNote says so).
* **Bar**: fills the space between the label and the value (`flex-1`, at least 24px),
  `ti-context-bar`. Hidden when the window is unknown.
* **Value**: the tokens of the window, "221K of 1M" (`fmtTok` both sides). Nothing when the
  window is unknown. The percentage left the row for the hover card.
* **Hover card**: "22% of context window used" ("N tokens used" without a window), then
  while warm "Cache expires in 41 min" and "$2.21 to re-read it after that".

## Gotchas

* The track was `bg-cf-border`, which matches the row's hover background, so on hover only
  the fill showed. It is `bg-cf-text/12` now, visible on both backgrounds in both schemes.
* The long single-project e2e test in `thread-info.spec.ts` runs close to its 20s budget
  under four workers; it timed out once after all of its Context assertions had passed.
