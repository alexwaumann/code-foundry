# A waiting thread asks the user to look (2026-11-19)

A thread that subscribed to something and is waiting sorts under Working
(`sidebar-waiting-under-working.md`), where the user rarely looks. `thread look "<what>"`
is its one quiet way to ask for the user's eyes: a bell notification naming the thread, so
its row gets the bell mark (`notifications-4-row-mark.md`) and the bell lists it, without
any change to its status, section or sort.

## What landed

| Path | What |
|---|---|
| `internal/command/commands_thread_look.go` | `thread.look` (`--body`, `--withdraw`, `--id` defaults to the thread it runs in), `ThreadOnScreen`, `LookPost` |
| `internal/store/notification/look.go` | `LookKey` (`look:<thread>`), `ParseLookKey` |
| `internal/layout/thread_tab.go` | `State.ThreadTabSpace`: the space holding a thread's own tab |
| `internal/daemon/thread_look.go` | the glue that withdraws the request (below) |
| `internal/store/thread/flags.go` | `SetSeenHook` became `AddSeenHook` (returns its remover), so the flag glue and the look glue both hear the seen moment |
| `internal/command/commands_thread_subscribe.go` | the hint line in `thread subscribe`'s reply |
| `gui/frontend/mock/notifications.ts`, `mock/world.ts`, `mock/settings.ts` | the mock's `thread.look` |
| `internal/skills/files/code-foundry-orchestrate/reference/patterns.md` | the subscribe example shows the hint; one sentence on `thread look` |

## Decisions

- **A thin thread verb, not `notification.post`.** The post needs the fixed key, the level,
  time-sensitive and the on-screen rule, none of which an agent should have to spell. `thread.notify`
  does not exist as a verb, but `thread new --notify` is a different thing, so the verb is
  `thread.look`.
- **Source `command`, key `look:<thread>`.** The card reads "Code Foundry" like any
  `notification.post`, and no new host source had to be taught to the plugin store, the GUI's
  labels or the mock. The key is the store's own per-key rules: a second post with other words is
  `updated` in place (same id, new title, body and time), the same words are `unchanged`, and a
  withdrawn one comes back as a new arrival. A request the user dismissed stays dismissed while
  the words are the same (the store's rule for every key); other words ask again.
- **Level warning, time-sensitive.** The row's mark and the bell's count take the attention tone;
  the dock badge counts it and its arrival bounces once, as for any time-sensitive warning.
- **On screen means the thread's own tab is open in the space the window shows**
  (`layout.State.CurrentSpace`), a preview tab included, whether or not it is the active tab of its
  pane. A linked tab (diff, terminal) does not count. Unknown is "no window has loaded the
  layout" (`Snapshot.LegacyImported` false) or no layout: then it posts. The command succeeds
  either way; on screen it posts nothing and says so (`posted: false`, `reason: "on_screen"`). An
  earlier request still showing is left alone then: the seen rule takes it once the user is at the
  window.
- **Withdrawn when** (all withdraw, not dismiss, so asking again later shows again):
  - the user sees the thread: the thread store's seen moment, as an until-seen flag;
  - the thread's status turns to needs attention: a turn ended Done, or it asks a question or a
    permission. The glue follows each thread's status from the bus and acts on the transition
    only, so the user's own CLI post onto a thread already needing attention is not taken back at
    once by the next unrelated update. A waiting turn end is idle, so it keeps the request; an
    error does not withdraw (the brief named Done or an ask);
  - `thread look --withdraw`; the user's dismiss; the thread removed (the store's own glue).
    Archive keeps it, as for every notification naming a thread.
- **The hint** is one line after `subscribed …` whenever `thread subscribe` added a subscription
  (not `already subscribed`, not a one-shot that fired at once and is gone). It names the
  subscriber, since `--id` may subscribe another thread. Every target kind gets it: a PR or timer
  subscriber is waiting in the user's sense even when its status overlay does not say "waiting".
  `thread wait` blocks in a turn (the thread is busy, on screen as working), so it has no such
  line. `thread new --notify` subscribes the creator too but prints no hint: the creator's next
  `thread subscribe` or the skill text tells it.
- **Not in the agents' index** (`NoIndex`): listing it put the guide 15 bytes over its budget, and
  the subscribe reply is where a waiting thread needs it. `help thread look` and `commands` list it.

## Tests

- `commands_thread_look_test.go`: one notification per thread (second post replaces in place,
  same words unchanged, another thread its own, withdraw, ask again after a withdrawal), level,
  time-sensitive and thread; the on-screen rule through `layouttest` (no window loaded, tab in the
  current space, another space, back, closed tab) and a table over `ThreadOnScreen` (no layout, not
  imported, current, other space, no tab, only a linked tab).
- `commands_thread_subscribe_test.go`: the hint on every added subscription, none on `already
  subscribed` or a fired one-shot.
- `internal/daemon/thread_look_test.go`: the status transition table, and the glue on the real
  notification store (waiting keeps it, needs attention and the seen hook withdraw it).

## Gotchas

- The seen hook runs under the thread store's lock: the look glue only calls the notification
  store, which never waits on the thread store (as the flag glue).
- The guide budget (`internal/skills/budget_test.go`) is within bytes of its cap; a new indexed
  verb in the Thread category does not fit.

## End to end (2026-11-19, `make drive DAEMON=dev`, scratch home under /tmp, Haiku 5.5 low)

A no-project thread "Release prep" started a background `sleep` and ran `thread subscribe --at
30m`. The subscribe reply Claude saw ended with the hint line; the thread then read `waiting (on 1
shell)` and sat under Working, its tab open in Main, the current space.

- `thread look --id <it> "Pick the release name" --body …` with its tab in the current space:
  `not needed: … is on screen in the space the user's window shows; nothing was posted`, exit 0,
  `notification list` empty.
- After `space new --name Other` (current): `asked the user to look … (n-41b4…)`; again with
  other words: `updated the request to look in place (n-41b4…)`. One notification, warning
  (time-sensitive), `time_sensitive` 1, the thread still `waiting`.
- Its tab closed, back in Main: the Working row shows the amber bell with 1, the bell lists the
  card "Pick the release name today" with the thread link (screenshots in the PR).
- Told to stop its background shell: the turn ended `attention (finished)` and the request was
  `withdrawn`.
- Claude itself ran `code-foundry thread look "Review the summary"` (the context thread): the same
  notification id came back as a new arrival, then was withdrawn as that turn ended Done.

The time-sensitive toast keeps the first title after an in-place update: updates never toast and
a time-sensitive toast stays until closed (`notifications-3-bell.md`); the bell and the row's
card show the new words.
