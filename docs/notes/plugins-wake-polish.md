# Plugins: wake polish (pluginsdk v0.2.1)

Six small SDK and skill gaps found while the three Code Foundry plugins (gh-actions,
showcase, test-watcher) adopted wake sources (`plugins-wake-sources.md`). All additive: a
v0.2.0 plugin runs unchanged against this host, a v0.2.1 plugin against a v0.2.0 host
just never gets `rearm`/`wake/armed`. Tag after merge: `pluginsdk/v0.2.1`.

## What changed

1. **Nothing before Init returns.** `pluginsdk.Serve` holds back everything the host
   sends except `initialize`, `ping` and `shutdown` until `Plugin.Init` has returned (at
   `initialized` when there is no Init): `wake/subscribed`, `wake/unsubscribed`,
   `wake/armed`, events, terminal exits, secret changes, surface visibility/close, and
   the requests `command/invoke`, `surface/open`, `surface/act`. Notifications wait on
   the conn's single notify goroutine, so they reach handlers in the order they came;
   requests wait on their own goroutines. If Init fails (or the host shuts the plugin
   down first) a held request answers `CodeUnavailable` (or sees the connection close)
   and no handler runs. Before
   this, the host's re-arm replay right after `initialized` raced Init, so
   test-watcher's `OnWakeSubscribed` had to check whether Init had loaded its settings
   yet and Init re-followed whatever arrived first (`initWakes`).
2. **Re-arm vs new.** The host sends a replayed subscription with `rearm: true`
   (`WakeSubscription.Rearm`) and, after the replay, one `wake/armed {count}`
   (`WakeArmed`, `Plugin.OnWakeArmed(ctx, h, count)`), also when the count is 0. A
   plugin that saves subscriptions in its data dir drops the ones not replayed: they
   ended while it was down (the host sends no `wake/unsubscribed` for those). It is
   sent under the actor's wake mutex with the replay, so it comes before any new
   subscription. plugintest: `Options.WakeSubscriptions` are replayed at Start with
   `Rearm`, then `wake/armed` (0 with none); they are sent before Start waits for Init,
   so a test with them also exercises the hold-back.
3. **Skill.** The plugin skill said to end flag reasons with `WakeHint`, but a reason
   is one line of at most 80 characters and the subscribe line alone is longer. Now:
   messages, notices and timeline text, never a flag reason (SKILL.md, host-api.md,
   the `WakeHint` doc comment). manifest.md says `plugin wakes` already prints each
   arg's default ("default this thread's id / pull request / project", else the
   `default` value), so arg descriptions say what they select, not their default.
   protocol.md documents the hold-back in the lifecycle and the `rearm` field and
   `wake/armed` row; testing.md the new option.
4. **Terminal reads.** libghostty's screen text of a part-filled screen ends with a
   newline (the blank rows below), so `strings.Count(text, "\n") + 1` was one too high
   (showcase trimmed it; hello's `read-shell` did not). The host now trims trailing
   newlines from both reads before cutting and sets `lines` for screen reads too
   (`terminalRead`); plugintest's fake does the same. hello's `read-shell` uses
   `screen.Lines`, falling back to a trimmed count for an older host.
5. **SDK pin uses the tag.** `make build` resolves `git tag --points-at HEAD --list
   'pluginsdk/v*' --sort=-v:refname | head -n 1` into a new ldflag
   `version.PluginSDKTag` (`PLUGINSDK_TAG`, empty when none; overridable on the make
   line). `version.Info.PluginSDKTag` → `skills.Sources.SDKTag` → `SDKPin(commit, tag)`:
   `vX.Y.Z` when the tag is a plain `pluginsdk/vX.Y.Z` and the commit is clean, else the
   commit, else `main`. `make package` (and so `scripts/release.sh` and the release
   workflow) runs `make build`; the workflow checks out with `fetch-depth: 0` and
   `fetch-tags: true`, so the tag resolves there.
6. **The plugins keep their workarounds** for now; with 0.2.1 they can drop them:
   test-watcher its Init race guard (`a.st == nil` checks in `wakeSubscribed`, the
   re-follow in `initWakes`) and its 10-minute `wakeLinger` timer (prune wake-only
   threads in `OnWakeArmed` instead), showcase its `TrimRight` before counting screen
   lines (`tab_owned.go`).

## Decisions

* **Block the notify goroutine, no second queue.** Waiting on the conn's one notify
  goroutine keeps the order for free and keeps the conn's bounds (4096 notifications,
  16 MiB): a long Init with a flood of events loses the excess with an `OnIssue`
  line, as a slow `OnEvent` already did. Cost: Init must not wait for a notification
  (an event, a terminal's exit) or a command; documented in the `Init` doc, protocol.md
  and testing.md (`NoInitWait`).
* **Everything held, not just wakes.** The brief listed surfaces, commands and events
  too; terminal exits, secret changes and surface visibility/close came along since a
  handler of any of them may read what Init sets up. Ping and shutdown are not held:
  a slow Init must not miss pings, and shutdown must work while Init runs.
* **`wake/armed` always**, whatever the manifest declares, whenever the host has a wake
  sink (the daemon always does): simpler than deciding per plugin, and an older SDK
  ignores the unknown notification.
* **A dirty tree ignores the tag**, as it ignores the commit: its SDK may differ from
  both.
* plugintest names the option `WakeSubscriptions` (`Options.Wakes` is already the
  manifest's sources).
* The hello example logs `rearm` on "tick armed" and "wake subscriptions replayed" on
  `wake/armed`, to show both in `plugin logs`.

## Tests

* `pluginsdk/serve_test.go`: `TestServeHoldsBackUntilInit` (replay, armed, an event, a
  new subscription, an unsubscription and a command sent while Init blocks: nothing runs,
  ping answers; after Init the notifications in order), `TestServeHeldBackWhenInitFails`.
* `pluginsdk/plugintest/wakes_test.go` `TestWakeRearmAndArmed` (a plugin pruning saved
  subscriptions on `OnWakeArmed`: one of two replayed, none replayed);
  `owned_test.go` a part-filled screen.
* `internal/store/plugin/wakes_test.go`: the helper plugin records `rearm` and
  `wake/armed`; `newWakesEnv` waits for the first `wake/armed` (0), which also closes a
  small race where a test's first subscription could be both replayed and sent new;
  after a restart the subscription comes back with `rearm` and `wake/armed` says 1; a
  later subscription is not a re-arm.
* `terminal_read_internal_test.go`: part-filled screen, blank rows below, a blank row
  inside kept, an empty screen, scrollback with a trailing newline, `lines` on screen
  reads; `owned_test.go` (real plugin process) expects `lines` on screen reads.
* `internal/skills/plugin_test.go` `TestSDKPin`: tag preferred, non-SDK, pre-release and
  non-semver tags ignored, dirty ignores the tag; the rendered SKILL.md for dirty,
  commit and tagged builds.
* hello `TestReadShell` (a part-filled screen counts 2), `TestLineCount`.

## End to end (isolated `CODE_FOUNDRY_HOME=~/.cf-wp-e2e`)

`make build plugins`, `daemon --dev`, `plugin dev plugins/examples/hello --yes`, a
`thread new --no-project --created-by=` thread (no prompt, no Claude turn):

```
$ code-foundry thread subscribe --id s-6a05a42fd98c --plugin hello/tick --arg every=1h --repeat
$ code-foundry thread subscribe --id s-6a05a42fd98c --plugin hello/tick --arg every=2h --repeat
$ code-foundry plugin restart hello
$ code-foundry plugin logs hello | grep -E "hello is up|tick armed|replayed|re-armed|running|wake subscription"
22:03:47.092 host       running
22:03:47.092 log info   hello is up … flags=0 host=dev
22:03:47.092 log info   wake subscriptions replayed count=0
22:03:51.087 host       wake subscription sub-337afdc27e34 to tick by s-6a05a42fd98c (every=1h)
22:03:51.087 log info   tick armed every=1h rearm=false subscription=sub-337afdc27e34
22:03:51.102 host       wake subscription sub-3771fcca81d2 to tick by s-6a05a42fd98c (every=2h)
22:03:51.103 log info   tick armed every=2h rearm=false subscription=sub-3771fcca81d2
22:03:51.122 host       running
22:03:51.122 host       re-armed 2 wake subscriptions
22:03:51.122 log info   hello is up … (Init's line, before the replay reaches the handlers)
22:03:51.122 log info   tick armed every=1h rearm=true subscription=sub-337afdc27e34
22:03:51.122 log info   tick armed every=2h rearm=true subscription=sub-3771fcca81d2
22:03:51.122 log info   wake subscriptions replayed count=2
$ code-foundry plugin hello read-shell        # 8 s after the clock started: a part-filled screen
Clock t-848056d18157: 4 lines with the scrollback, 4 on the screen   # was 5 on the screen
$ code-foundry plugin hello read-shell --json | jq -c '{lines, screenLines}'
{"lines":4,"screenLines":4}
$ code-foundry thread unsubscribe --id s-6a05a42fd98c --plugin hello/tick   # removed both
```

The dirty build's installed skill pinned `pluginsdk@main`. After committing, `make build
PLUGINSDK_TAG=pluginsdk/v0.2.1` (a clean commit, the tag simulated on the make line)
and a daemon start installed `go get github.com/alexwaumann/code-foundry/pluginsdk@v0.2.1`.
No ERROR lines in either daemon log; the daemon was stopped and `~/.cf-wp-e2e` removed.

## Gotchas

* **Tip releases race the SDK tag.** The release workflow builds a tip on every push to
  main, usually before `pluginsdk/vX.Y.Z` is pushed on that merge commit, so that tip's
  skill pins the commit (still correct, just not the tag). A later build of the same
  commit (`make promote` for stable, a local `make build`) pins the tag. Push the SDK
  tag first if the tip should carry it.
* `SKILL.md` of the plugin skill is still at its 120-line cap; the wake bullet was
  rewritten to fit.
* Tags are shared by every worktree of the repository: the Makefile resolution was
  checked against `363eda43` (`pluginsdk/v0.2.0`), not by tagging a test commit.
