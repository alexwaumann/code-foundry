# Snooze until an event (2026-11-19)

Most "later" in a coding tool is an event, not a time: checks finish, a pull request is reviewed
or merged, a deploy finishes. A user asked to snooze a thread until that event, from the menus and
by telling Claude ("snooze this thread until checks pass on #812"). Builds on
`snooze-without-teardown.md` (a snooze hides and closes nothing), `save-for-later-1-daemon.md`,
`gh-events-3-pr-wake.md`, `plugins-wake-sources.md` and `subscribe-cannot-fire.md`.

## Model: a save for later that an event ends, watched by a subscription the store owns

* **The thread.** An event snooze is a save for later (`SavedAt` set, `SnoozedUntil` zero: no wake
  time, so `Snoozed()`, the lists, the Snoozed section's order and `wakeSnoozed` need no change),
  plus `Thread.SnoozeEvent` (what it waits on). When the event ends the snooze, `SavedAt` and
  `SnoozeEvent` clear and `SnoozeEndedBy` says why in plain words; the thread gets "snooze ended"
  exactly as a timed wake gives it (on its row when stopped, on its runner at its prompt; a working
  thread keeps its status). Any other snooze, an unsnooze, the user's message, a pin and an archive
  drop the event (`putAway` and `unsnoozeLocked` call `dropSnoozeEventLocked`), and a new snooze
  clears `SnoozeEndedBy`.
* **The watch.** A wake subscription the thread store owns for the thread (subscriber: the thread
  itself), marked by `subRec.snooze`. Chosen over a field on the thread watched by the sources
  because the subscription engine already does everything the watch needs: the GitHub poll's watch
  set (`syncWatchLocked`), the plugin's `wake/subscribed`/`wake/unsubscribed` and re-arm at every
  plugin start (`PluginSubscriptions`), persistence and restart, and the cannot-fire rules. A field
  would have needed each of those taught about a second kind of watcher. The difference is only the
  fire: in `PullRequestChanged`, `FirePlugin` and `PluginWakesGone` a snooze subscription ends its
  thread's snooze (`endSnoozesLocked`) instead of queueing a wake, so the 60/hour wake limit never
  sees it and nothing is sent to Claude. It is left out of `thread subscriptions`, unsubscribe by id
  or target, and the "already subscribed" dedupe.
* **Persistence: new tables only** (migration 0065), so the way back from 0061
  (`wayback/0061_layout.sql`) can drop them: `thread_snooze_events` (one row per thread: the
  subscription it waits on with the title and plugin name the GUI shows, or, once ended, `ended_by`)
  and `snooze_recent_events` (the plugin sources the user snoozed on, ten at most). The row is
  written before the subscription, so a failure in between never leaves a subscription that would
  wake the thread with a message. At startup (`loadSnoozeEvents`) a row whose thread is no longer
  saved, or whose subscription is gone, is dropped with its subscription; the thread stays saved for
  later.

## Refusals and endings

| When asked | Answer |
|---|---|
| neither or both of a pull request and a plugin source; `changed`; a thread condition; args on a pull request; a condition on a plugin | InvalidArgument |
| `#812` with no pull request on the thread | InvalidArgument: give owner/name#812 |
| GitHub says it does not exist / cannot be asked | FailedPrecondition (not kept unchecked as a subscription is: a snooze that may never end is worse than a retry) |
| already met (checks done/passed/failed, merged, closed) | FailedPrecondition: "checks on #812 already finished (12 passed, 2 failed); there is nothing to wait for" |
| closed or merged so it cannot happen | FailedPrecondition: "#812 is closed, so it can no longer be merged" |
| unknown plugin or source, disabled plugin | the plugin store's NotFound / FailedPrecondition, as subscribe |

Endings, `SnoozeEndedBy`: "Checks failed on #812 (2 of 14)", "Checks passed on #812 (14 of 14)",
"#812 was reviewed (approved by octocat)", "#812 got a new comment", "A review was requested on #812",
"New commits were pushed to #812", "#812 was merged", "#812 was closed"; cannot happen any more:
"#812 was closed, so it can no longer be merged"; a plugin fire: "<Plugin>: <fire title>"; a source
gone: "<Plugin>: <source> can no longer fire (the plugin was disabled)".

## Surface

* `thread.snooze --until-pr <owner/name#N|URL|#N> [--on checks_done|checks_passed|checks_failed|review|comment|review_requested|head_pushed|merged|closed]`
  and `--until-plugin <plugin>/<source> [--arg k=v …]`; exactly one of until, save, clear or an
  event. Works with `--ids` (one event for all) and from a thread on itself (`by_thread_id`, at
  once). The description says all of it, so an agent needs no other doc.
* `thread.snooze.events [id] [--json]` (read-only, NoIndex, NoPalette): the thread's open, non-draft
  pull requests newest first (by number) with their pending conditions, every running plugin's wake
  sources with the args they would take for the thread, and the recent plugin sources. Pending: no
  checks finish once checks are done (or when the pull request has no checks at all), no reviewed
  once approved, the rest while open. API: `SnoozeThreadRequest.event`, `ThreadService.SnoozeEvents`,
  `Thread.snooze_event` (with the daemon's `label` and `waiting_for`) and `Thread.snooze_ended_by`.
* Setting `threads.snooze_events` (General › Events in “Until event”): space-separated words,
  pull request events and `plugin:<plugin>/<source>`; default `checks_done review merged`. The GUI
  draws the section as checkboxes (`sectionBodies`).

## GUI

* **Until event** after Save for later in the row's, header's and pill's Snooze menus
  (`SnoozePresetItems` given a `kit`): up to three pull requests (a label line "#812 Title", then its
  checked pending events), "Plugins" and up to three plugin events (the recent ones first, filled from
  the checked ones), then More events… and Choose what shows here…. Hidden while the read is out and
  when the thread has nothing to wait on. Not in the bulk menu: each thread waits on its own pull
  requests, so the bulk menu stays with times.
* **More events…**: a dialog with a cmdk list of every event, grouped the same way; the filter
  matches every typed word against the row's words ("812 merged", "deploy"); Enter snoozes. Opened
  two frames late, as the move picker is, or the menu's focus return takes the keyboard from it.
* **Choose what shows here…**: Settings on General, the section focused (`focusSetting` on its
  `data-setting`, retried for up to 30 frames while the page draws).
* **The Snoozed row**: a pull request or plug glyph and the daemon's label ("#812 checks",
  "deploy") where a timed row has its alarm and countdown; same quiet classes. The hover card says
  "Snoozed until checks finish on #812", and on a woken thread the sentence that ended it. The
  composer pill reads "Snoozed until …" with the glyph, and "<sentence> · 5m ago" once woken.
* Mock: `thread.snooze` takes the event args, `thread.snooze.events`, the setting, wake sources on
  four plugins, `POST /__mock/thread/snooze-event-fire?id=…[&by=…]` ends one.

## Choices where the brief was silent

* The plugin ending reads "<Plugin>: <title>" (the wake header's form), not "<title> (<plugin>)".
* A recently used plugin source shows in the submenu even when not checked in Settings (the brief:
  the recent ones, filled from the checked).
* Only the user's snoozes count as recent; a thread snoozing itself does not move the list.
* `#N` resolves among the thread's pull requests, else in the repository of its first; not from
  the project's slug.
* The Settings section sits after Lifecycle on General: the settings tests require Text generation to
  follow "Name threads automatically" directly.

## Tests

Go: `snooze_event_test.go` (refusals table, each condition ending with its sentence, no wake sent
past a spent wake limit, the watch set, restart, the cannot-happen endings, a plugin fire and source
gone, the recent order, every other way the event is dropped, a thread on itself while live, the
events read, the words), API (`thread_snooze_event_test.go`), command (`TestThreadSnooze` rows,
`TestThreadSnoozeEvents`), daemon (`TestThreadPluginWakeSources`), settings
(`TestSnoozeEventsField`), the way back. Vitest: `lib/snoozeEvents.test.ts`,
`snooze/UntilEventMenu.test.tsx` (submenu and caps, bulk, the commands, More events filter and
Enter), `settings/SnoozeEventsSettings.test.tsx`, `SidebarRow.test.tsx` (row label, card),
`composerPill.test.ts`, `mock/snoozeEvent.test.ts`. e2e `snooze-event.spec.ts`: the menu to More
events keyboard flow, and the SHOTS.

## End to end

2026-11-19, the branch binary through a wrapper unsetting `CLAUDE*` and `CODE_FOUNDRY_*`,
`CODE_FOUNDRY_HOME=~/.cf-sue` (the scratchpad path was past macOS's 103-byte socket limit),
`daemon --dev`, the hello example plugin linked with `plugin dev`, a no-project thread:

```
$ cf thread snooze events --id s-3641c75b7f5b
Tick (Hello): --until-plugin hello/tick --arg every=10s
$ cf thread snooze --id … --until-plugin hello/tick --arg every=1h
snoozed thread snooze e2e (s-3641c75b7f5b) until Tick (Hello)
$ cf thread snooze --id … --until-plugin hello/tick --until 1h
code-foundry thread.snooze: give one of until, save, clear, until-pr or until-plugin
$ cf thread snooze --id … --until-pr '#5'
code-foundry thread.snooze: thread s-3641c75b7f5b has no pull request to take the repository of #5 from; give owner/name#5
$ cf thread snooze --id … --until-pr alexwaumann/code-foundry#515 --on merged     # closed on GitHub
code-foundry thread.snooze: #515 is closed, so it can no longer be merged
$ cf thread snooze --id … --until-pr alexwaumann/code-foundry#543 --on merged     # merged on GitHub
code-foundry thread.snooze: #543 is already merged; there is nothing to wait for
$ cf thread subscriptions --id …
thread s-3641c75b7f5b has no wake subscriptions
# plugin log: wake subscription sub-698b5c38ed1d to tick by s-3641c75b7f5b (every=1h); tick armed
# SIGTERM, start again: "re-armed 1 wake subscriptions", thread get still shows the event
$ cf plugin hello fire-tick --every 1h
fired tick for every=1h: woke 1
{"savedAt":null,"snoozeEvent":null,"status":"THREAD_STATUS_NEEDS_ATTENTION","statusReason":"snooze ended","snoozeEndedBy":"Hello: tick 1 (every 1h)"}
$ cf thread items --id …
(no items yet)                                     # nothing was sent to Claude
$ cf thread snooze --id … --until-plugin hello/tick --arg every=1h; cf plugin disable hello
{"savedAt":null,"statusReason":"snooze ended","snoozeEndedBy":"Hello: Tick can no longer fire (the plugin was disabled)"}
```

No ERROR lines in either daemon log; the daemon was stopped and `~/.cf-sue` deleted. The GUI was
exercised against the mock daemon (`e2e/snooze-event.spec.ts` and its SHOTS), not a dev daemon.
Not exercised live: a real pull request's change ending a snooze (no pull request was changed for
this; covered by the store tests).

## Daemon restart

Needed: migration 0065, new RPC, request and thread fields, command flags and a setting.
