# Sidebar: a thread waiting on its child threads sorts under Working

GUI only, one PR. Asked by Alex on 2026-10-31 alongside the PR tag change
(docs/notes/sidebar-pr-tag-plus.md), as its own PR.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/lib/thread.ts` | `isWaiting` lives here now (re-exported by `lib/waiting.ts`, whose callers are unchanged); `threadGroup` returns `"working"` for a waiting thread |
| `gui/frontend/src/lib/tree.ts`, `lib/waiting.ts` | docs |
| `gui/frontend/src/lib/thread.test.ts`, `tree.test.ts` | the new group and order |

## Behaviour

* A thread the daemon reports idle with the reason "waiting on N child threads" (or
  "waiting" alone, a queued wake) is in the Working footer, counted in its header, and
  sorted with the working threads (newest created first). Before it sat among the idle
  threads of the main list (docs/notes/orch-waiting-status.md), where a lead that was
  only waiting for its team looked finished.
* Its row is unchanged: "Waiting" with the time, and "2 child threads" on line 3. Ember's
  board already read a waiting lead as Working; the sidebar now agrees.
* Nothing else moves: the attention count (bell, title, dock) never counted it, and
  cmd+shift+a still skips it. cmd+1..9 follow the list order, so it now numbers after
  the main list, with the Working rows.

## Gotchas

* `lib/waiting.ts` imports `threadBadge` from `lib/thread.ts`; `threadGroup` importing
  `isWaiting` back made a cycle, so `isWaiting` moved into `lib/thread.ts`.
