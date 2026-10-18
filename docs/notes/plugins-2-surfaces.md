# Plugins 2: surfaces, view validation, predicates (2026-10-18)

The second PR of the plugin stack (`docs/sketches/plugins/DECISIONS.md`, build order row 2),
on `cf/plugins-1-core` (`docs/notes/plugins-1-core.md`). The daemon side of plugin UI:
surface instances and their views, availability predicates over host facts, the
`plugin.<name>.show.<surface>` commands that carry availability to the GUI, `pr.checks`,
and `UiIntent.InvokeCommand`. No GUI yet (PR 5 renders the views).

## What is here

| Piece | Where |
|---|---|
| Surface instances: open/visibility/close, versions, coalescing, appends, toasts | `internal/store/plugin/surface.go` |
| View validation, the plugin's `view/*` and `context/set` methods, acts | `internal/store/plugin/surface_act.go` (registered into `host.go`'s maps from its `init`) |
| When-clause compiler and evaluator | `internal/store/plugin/predicate.go` |
| Host facts, the async pull request checks fact, `context/set` facts | `internal/store/plugin/facts.go`; the daemon's `FactSource` in `internal/daemon/pluginfacts.go` |
| Show commands, manifest commands' `when` | `internal/store/plugin/show.go`, `commands.go` |
| `host/invoke` with `confirm: "ask"` | `internal/store/plugin/ask.go` |
| `PluginService.WatchSurface`, `GetSurface`, `Act`; surface availability in `List` | `proto/codefoundry/v1/plugin.proto`, `internal/api/plugin_surface.go` |
| `plugin surface [--watch]`, `plugin act`, `pr.checks` | `internal/command/commands_plugin_surface.go`, `commands_pr_checks.go`, `cmd/code-foundry/plugin.go` |
| Check runs' GitHub App slug | `internal/store/gh` (`checkSuite { app { slug } }`), `CheckRun.app`; `pluginsdk.CheckProvider` |
| SDK | `Host.UpdateView` (now a request), `AppendLog`, `AppendLogLines`, `InvokeAsk`, `ToastIn`; `SurfaceAct.Value`, `StoredSecret`; `plugintest` opens surfaces and acts |
| Example | `plugins/examples/hello`: surfaces `demo` (every node kind), `pinned`, `checks` |
| Captured views for PR 5 | `internal/store/plugin/testdata/hello-demo/{overview,form,log}.json` |

## Decisions

### Method names (settled)

ARCHITECTURE §B.2's names, not PRIMITIVES §C's (`surface/render`, `surface/append`,
`surface/event` are not used):

| Method | Direction | Kind |
|---|---|---|
| `surface/open {instance, surface, context, facts}` | host → plugin | request (5 s) |
| `surface/visibility {instance, visible}` | host → plugin | notification |
| `surface/close {instance, reason}` | host → plugin | notification (`idle`; `shutdown`, `gone` reserved) |
| `surface/act {instance, version, kind, action, key, data, field, value, values}` | host → plugin | request (10 s) |
| `view/update {instance, view}` → `{version}` | plugin → host | **request** (also accepted as a notification) |
| `view/append {instance, key, text \| lines}` → `{version}` | plugin → host | request or notification |
| `view/toast {instance?, level, text}` | plugin → host | notification |
| `context/set {key, value, threadId? \| projectId?}` | plugin → host | notification |

`view/update` is a request in the SDK, not ARCHITECTURE's notification: a refused view
reaches the plugin as a JSON-RPC error (`-32602 view rejected: …`) only as an answer, and
a caller that waits for the answer keeps its own views in order (requests are served
concurrently, notifications in order). A plugin that sends it as a notification still
works; a refusal then only reaches its log. The same holds for `view/append`.

### Instances

* Key `<plugin>/<surface>/<scope id>`, scope id `global`, `thread:<id>`, `project:<id>`,
  `worktree:<path>` or `pr:<owner>/<repo>#<n>` (PRIMITIVES §C's form). A thread's project,
  worktree and pull request come from the facts (below), so a project-scoped surface opened
  from a thread is that thread's project's instance.
* The context the plugin is told is the scope's: a thread instance gets the thread, its
  project, worktree and workspace; a project instance the project; global nothing. A `pr`
  instance gets `facts.pr = {repo, number, url}`. `facts` also carries the value of every
  fact the surface's when clause reads (the Jenkins check URLs, say).
* First watcher: `surface/open`, then `visibility true`. A view sent before the open is
  answered counts (the SDK's factories render inside `surface/open`). Last watcher gone:
  `visibility false` at once, `surface/close` after the grace (60 s). The view stays
  cached: a returning watcher gets state `opening` ("updating") and the cached view, then
  the new one.
* No view 10 s after opening: `not responding`. The plugin not running: `plugin down` with
  the plugin's state in words; when it runs again every watched instance is reopened.
  A plugin's error to `surface/open`: `failed` with its message.
* Versions grow per accepted view. An identical view (same canonical JSON, no log
  content) is no new version. The elements of the last 4 versions act; `Act` with
  version 0 means the current one (CLI, agents).
* Coalescing is per watcher: it pulls the latest state at most every 100 ms, so a burst
  of 100 views reaches it as a few (`TestSurfaceAppendsAndCoalescing`). More than 50
  views a second for 10 s: one a second for that instance, plus an issue.

### Views: validated, re-encoded

The daemon decodes `view/update` into `pluginsdk/ui`'s types, runs `ui.Validate` (every
v1 node, the limits, keys, URLs, secrets), and adds what only the host can check: a
command action names one of the plugin's own commands or one its `permissions.commands`
allow (never a `plugin.*` management verb), and a secret input's `store` needs the
`secrets` permission. The raw view is capped at 1 MiB (256 KiB plus four 64 KiB logs).
Viewers get the **re-encoded** JSON, not the plugin's bytes (ARCHITECTURE §B.6 said
byte-for-byte with generic checks): unknown fields are dropped and a node kind this host
does not know is invalid, so the GUI only ever sees the schema it was built for. A plugin
checks the `view.node.<kind>` capabilities before using a newer node.

`thread` and `terminal` nodes are validated (an id, rows 4..60) and passed on; they stay
inert until PR 6 (the GUI renders a placeholder). They are not announced as capabilities.

An invalid view: the JSON-RPC error names the problems (first 10), the plugin's log has
all of them, and the plugin gets an issue (`surface demo: its last view was rejected: …`)
until its next valid view. The instance keeps its last valid view; with none yet (or for a
dev plugin, above it) it shows a host-made `notice` (tone error, key `cf-invalid-view`,
`host_rendered` set) pointing at `code-foundry plugin logs <name>`.

### Logs

A log node has `text` or `lines`. A view whose log node sets either replaces that node's
buffer; one that leaves both empty keeps it; a node no longer in the view drops it. The
host keeps the last 2,000 lines or 256 KB per node (head-trimmed, `truncated` set).
`view/append` adds up to 64 KB to a node of the current version: text to a text log,
lines (with tones) to a lines log (text appended to a lines log splits into lines). Viewers
get `SurfaceLogAppend`s (consecutive ones merged); one that joins later, or fell more than
512 appends behind, gets the view with the buffers in it.

### Acts

The GUI (or `plugin act`) names an element by key (and optionally its action, checked);
the daemon takes everything else from its own copy of that view version: the kind
(`click`, `submit`, `change`, `tab`), the event name, its `data`, the enclosing form. So a
client can neither forge `data` nor act on what the view does not offer.

* `values` must be fields of the element's form (any field of the view for a click
  outside a form); a secret field only in a submit. Types are checked: strings, booleans
  for toggles, string lists for multiple selects.
* A secret input with `store`: the daemon writes the value to the Keychain under the
  plugin's namespace (and `plugin_secrets`) and the plugin gets `{"key": …, "stored": true}`.
  The value never reaches the plugin, the log or a view.
* `command`, `open_url` and `copy` elements are the host's (the GUI runs them;
  `GetSurface`'s element list marks them); `Act` refuses them.
* The plugin's error is `ErrPluginRefused` → Connect `Aborted`, its message as the
  error (the GUI toasts it; the CLI prints it and exits 1). Host form drafts are the
  GUI's (PR 5); the daemon keeps none.

### Predicates

```
expr    := or ;  or := and ("||" and)* ;  and := unary ("&&" unary)*
unary   := "!" unary | "(" expr ")" | operand [op operand]
op      := "==" | "!=" | "=~" | "in"
operand := fact | "str" | 'str' | number | true | false | null | [literal, …] | /re2/
fact    := segment ("." segment)*        segment := [A-Za-z_][A-Za-z0-9_-]*
```

A bare operand is truthy (null, false, "", 0, [] are not). `==`/`!=` compare like kinds;
with a list on either side `==` holds if any element pairs up, `!=` if none does. `=~`
needs a regex on the right. `x in y`: any element of x equals any element of y (a scalar
is a one-element list), so `"github-actions" in pr.checks.provider` and
`project.slug in ["a/b", "c/d"]` both read naturally. Comparisons do not chain.
Three-valued: an async fact not fetched yet is unknown; `unknown && false` is false,
`unknown || true` true, otherwise unknown, which lists as unavailable ("not known yet").
Compiled when the manifest loads (cached by source); a clause that does not compile is a
plugin issue (`commands[5].when: …`) and its command or surface is never available.

| Fact | Value |
|---|---|
| `view` | the context's view name |
| `thread`, `thread.id`, `thread.state`, `thread.status`, `thread.branch` | a known thread is active; its fields |
| `thread.hasPr`, `thread.pr.url` (list), `thread.pr.number`, `thread.pr.repo` | the thread's pull requests: its branch's (an open one first, as the GUI's pull request surface picks), then the ones Claude linked, newest first; `number`/`repo` are the first's |
| `project`, `project.id`, `project.name`, `project.slug`, `project.git` | the context's project, else the thread's |
| `workspace`, `workspace.id` | the context's workspace, else the thread's |
| `pr.checks` (has any), `pr.checks.provider`, `.app`, `.name`, `.workflow`, `.url`, `.conclusion` (lists) | the checks of the thread's first pull request: **async** |
| `<plugin>.<key>` | what a plugin set with `context/set`: the thread's, else the project's, else global |

`pr.checks.provider` is `pluginsdk.CheckProvider`: the check run's GitHub App slug
(`github-actions`), else `github-actions` for a details URL under
`github.com/<owner>/<repo>/actions/`, else `status` (a commit status: Jenkins and other
external CI). The gh store now fetches `checkSuite.app.slug` (one more field in the
existing query); older cache entries fall back on the URL rule.

**The async fact.** Reading `pr.checks.*` for a pull request whose checks are not cached
schedules one fetch (deduplicated per pull request) through the daemon's `FactSource`,
which calls the gh store's `PullRequest` (its `DetailTTL` cache). Until it answers the
fact is unknown. Its arrival (or a change on a later refresh) bumps the availability
epoch and publishes `AvailabilityChanged`, which reaches clients as
`PluginEvent.availability_epoch` (throttled to one per 250 ms) so the GUI re-lists
commands. Entries are fresh for 60 s, then served stale while a refresh runs; a failed
fetch counts as no checks (known), retried when stale; 256 entries, unused ones dropped
after 10 minutes. Only contexts someone lists are evaluated, so the cost is one cached
read per selected thread with a pull request.

**`context/set`.** `key` with or without the `<plugin>.` prefix
(`[A-Za-z_][A-Za-z0-9_-]*` segments, ≤ 64), `value` null (removes), boolean, string
(≤ 1 KB), number or a list of them (≤ 100); global, or for `threadId` or `projectId`.
At most 1000 per plugin. Facts belong to the plugin process that set them: a restart (or
crash) starts with none. A change publishes `AvailabilityChanged`.

### Show commands (the convention PR 5 builds on)

Per manifest surface the store registers `plugin.<name>.show.<surface>` with the
plugin's other commands (`ReplacePrefix`):

* Title `Show <surface title>`, category the plugin's display name, no default chord.
* One context arg by scope: `thread` (thread and pr scopes, an id with suffixes),
  `project`, or `worktree`; none for global.
* `When`: the scope's context is there (a known thread; a project; a worktree; the
  thread's pull request) **and** the when clause holds. Not the plugin's running state: a
  crashed plugin's tab still opens and says so. `WhyUnavailable` says which.
* `Run` emits `UiIntent.ShowView{name}` with name `panel.plugin.<name>.<surface>` plus
  `?thread=<id>`, `?project=<id>` or `?worktree=<path>` for the scopes that read one.

For the GUI (PR 5): the surface kind is `plugin.<name>.<surface>` (`PluginSurface.kind`),
the tab id `kind[?params]`. A plugin surface is available exactly when its show command
(`PluginSurface.show_command`) is `available` in the commands store listed for the
panel's context (`contextKey` equal), so no evaluator in TS. Re-list commands on any
plugin event (`availability_epoch` included). On `ShowView panel.plugin.…`, strip the
query, select that thread or project if it is not the current selection, then open or
activate the tab. `WatchSurface(ref{plugin, surface, context})` with the panel's
selection; `GetSurfaceResponse.elements` is what the debug CLI prints.

Manifest commands' `when` is now their `When` (PR 1 registered them unconditionally).

### `confirm: "ask"` and toasts

`host/invoke` with `confirm: "ask"` of a command that asks first emits
`UiIntent.InvokeCommand{name, args, context, caller: "plugin:<name>"}` and answers the
plugin at once with `{message: "asked the user to confirm …", json: {asked: true,
delivered: n}}`. With no GUI watching intents it fails with `-32003` as before. The GUI
(PR 5) runs it through `runCommand`, whose confirm dialog shows the daemon's text; the CLI
ignores the intent. `view/toast` with an instance goes to that instance's watchers
(`SurfaceToast`); without one it is a `UiIntent.Notify` titled with the plugin's display
name. One toast a second per plugin.

Host capabilities announced in `initialize` now add `surfaces`, `view.v1`, `view.append`,
`context`, `invoke.ask`, `view.node.<kind>` for the twelve v1 node kinds, `view.tabs`,
`view.fieldset`, `view.optionsSource` and `view.duration`.

### `pr.checks`

`code-foundry pr checks <owner/repo> <number>` or `--thread <id>` (or `--context-thread`):
the thread's branch pull request, else its newest linked one. Prints name (workflow /
name), status or conclusion, provider, started, completed, URL; `--json` gives
`{repo, number, url, headSha, fetchedAt, lastError, checks: [{name, workflow, status,
conclusion, app, provider, url, startedAt, completedAt}]}` with lower-case enums. Served
from the gh store's cache like the PR panel. **Not in the agent guide**: the guide has 19
bytes left under its 29,000-byte cap; `guide.LeftOut` names it, and `code-foundry
commands` and `help pr.checks` show it.

### Proto additions

`PluginService.WatchSurface(WatchSurfaceRequest{ref}) → stream SurfaceUpdate{state | view |
append | toast | heartbeat}`, `GetSurface(GetSurfaceRequest{ref, wait_ms}) →
{state, view, elements}`, `Act(SurfaceActRequest{instance | ref, version, key, action,
value?, values: Struct}) → {version}`; `SurfaceRef{plugin, surface, context, instance}`,
`SurfacePhase`, `SurfaceState`, `SurfaceView{instance, version, view_json, host_rendered}`,
`SurfaceLogAppend`, `SurfaceToast`, `SurfaceElement`; `ListPluginsRequest.context`;
`PluginSurface.{when, show_command, kind, available, unavailable_reason}`;
`PluginEvent.availability_epoch`; `UiIntent.InvokeCommand`; `CheckRun.app`. `values` is a
`google.protobuf.Struct` (plain JSON on the wire) rather than ARCHITECTURE's
`map<string,string>`, since toggles are booleans and multiple selects lists.

## Gotchas

* A watcher's wake channel is filled by `activate` before the watcher's goroutine runs;
  the first wake is a non-blocking send (a blocking one deadlocked the first test).
* After a plugin restart the reopened instance often renders the same view: no new
  version, only the `live` state. `GetSurface` therefore ends its wait 200 ms after
  `live` when it already holds the cached view.
* `WatchSurface` flushes its headers before the first update (as `FollowLogs` does);
  otherwise a client blocks until the plugin's first view or a heartbeat.
* The store tests run the test binary as the surface plugin under their own variable
  (`CF_PLUGIN_SURFACE_HELPER`), so PR 1's helper modes stay as they were.
* `surfaceHub` locks: hub → instance; never the manager's `mu` while holding an
  instance's. `When` functions run under the registry's read lock and take the
  manager's `mu` (for the live conn) and the fact source's snapshots, never the registry.
* An isolated daemon still writes to the login Keychain (service
  `code-foundry-plugin`): delete what an e2e stored (`plugin secrets delete`).

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=/tmp/cfp2`)

```
make build plugins
export CODE_FOUNDRY_HOME=/tmp/cfp2
./bin/code-foundry daemon --dev &
./bin/code-foundry plugin dev plugins/examples/hello --yes --follow=false
./bin/code-foundry thread new --no-project --model 'claude-4.5-haiku[1m]' --name plugin-e2e --created-by=
T=s-47aac4538464   # the new thread (no prompt: Claude idles, nothing is sent)
```

Availability follows the context:

```
$ code-foundry plugin list
NAME   VERSION  STATE          PERMISSIONS                              COMMANDS  SURFACES                           NOTE
hello  0.1.0    running (dev)  commands(thread.send,pr.checks) secrets  6         demo(off) pinned(off) checks(off)
$ code-foundry plugin list --context-thread $T
hello  0.1.0    running (dev)  commands(thread.send,pr.checks) secrets  6         demo(on) pinned(off) checks(off)
$ code-foundry commands --context-thread $T | grep hello
Hello         plugin.hello.show.checks  no         Show Actions Checks
Hello         plugin.hello.show.demo    yes        Show Hello Demo
Hello         plugin.hello.show.pinned  no         Show Hello Pinned
Hello         plugin.hello.unpin        no         Unpin Hello
…
$ code-foundry plugin hello show checks --context-thread $T
code-foundry plugin.hello.show.checks: not available in this context: the thread has no pull request
$ code-foundry plugin hello show demo --context-thread $T --json      # no GUI running
{"delivered":0}
```

The view and its elements:

```
$ code-foundry plugin surface hello demo --context-thread $T
instance hello/demo/thread:s-47aac4538464: live
view version 1:
{ "header": { "icon": "sparkles", "title": "Hello demo", … }, "tabs": { … }, "nodes": [ … ] }
elements:
  KEY           KIND      ACTION                                       LABEL                 FORM
  hdr-refresh   click     refresh                                      Refresh
  hdr-docs      open_url  https://github.com/alexwaumann/code-foundry  Open the plugin docs
  overview      tab       tab                                          Overview
  …
  pin           click     pin                                          Pin to this thread
  greet         command   plugin.hello.greet                           Greet via command
  copy          copy      copy                                         Copy greeting
```

Acts round-trip (tabs, clicks, a form with a stored secret, the plugin's own error):

```
$ code-foundry plugin act hello demo click --context-thread $T     # twice
acted on click (view version 4)
acted on click (view version 5)
$ … header.trailing of version 6: "2 clicks"
$ code-foundry plugin act hello demo tab --key form --context-thread $T
acted on form (view version 6)
$ code-foundry plugin act hello demo save --values '{"name":""}' --context-thread $T
code-foundry: plugin.act: plugin refused: a name is required (aborted)      # exit 1
$ code-foundry plugin act hello demo save --values '{"name":"Ada","token":"tok-123","env":"prod","tags":["a","c"],"notifyFail":false}' --context-thread $T
acted on save (view version 7)
$ code-foundry plugin secrets list hello
KEY    SET
token  2026-10-18 06:12
$ … the form tab now says:
Saved: {"env":"prod","name":"Ada","notifyFail":false,"tags":["a","c"],"token":{"key":"token","stored":true}}
and the token input: {"kind": "secret", "hasValue": true, "store": "token"}
$ code-foundry plugin act hello demo save --values '{"nope":"x"}' --context-thread $T
code-foundry plugin.act: invalid argument: "nope" is not a field this action sends
```

A log append arrives (`plugin surface --watch` in another shell, then start a build):

```
$ code-foundry plugin surface hello demo --context-thread $T --watch
watching hello/demo/thread:s-47aac4538464 (Ctrl-C to stop)
state: live
view version 8: {…}
view version 9: {…}
view version 10: {…}
append to build-log (version 10): "[1/6] fetching sources\n"
append to build-log (version 10): "[2/6] compiling 12 packages\n"
…
append to build-log (version 10): "[6/6] done\n"
view version 11: {…}
$ … version 11's build-log node: {"text": "[1/6] fetching sources\n…[6/6] done\n", "rows": 12, "wrap": true, "title": "build 1"}
```

A context fact flips availability, and a restart clears it:

```
$ code-foundry plugin act hello demo pin --context-thread $T
$ code-foundry plugin list --context-thread $T
hello  …  demo(on) pinned(on) checks(off)
$ code-foundry plugin list
hello  …  demo(off) pinned(off) checks(off)
$ code-foundry commands --context-thread $T | grep -E 'pinned|unpin'
Hello         plugin.hello.show.pinned  yes        Show Hello Pinned
Hello         plugin.hello.unpin        yes        Unpin Hello
$ code-foundry plugin hello unpin --context-thread $T && code-foundry plugin list --context-thread $T
unpinned from s-47aac4538464
hello  …  demo(on) pinned(off) checks(off)
$ code-foundry plugin act hello demo pin …; code-foundry plugin restart hello; code-foundry plugin list --context-thread $T
hello  …  demo(on) pinned(on) checks(off)
restarted hello (starting)
hello  …  demo(on) pinned(off) checks(off)
$ code-foundry events --source plugin --json      # meanwhile
… {"plugin":{"availabilityEpoch":"3"}} …
```

`pr.checks` against a real pull request (the app slug from GraphQL):

```
$ code-foundry pr checks alexwaumann/code-foundry 191
alexwaumann/code-foundry#191 https://github.com/alexwaumann/code-foundry/pull/191
NAME           STATUS   PROVIDER        STARTED      COMPLETED    URL
local-check    success  status          10-18 05:30  -            https://github.com/…/docs/notes/ci-attest.md
ci / attested  success  github-actions  10-18 05:30  10-18 05:30  https://github.com/…/actions/runs/39119533061/job/117652111939
ci / frontend  skipped  github-actions  10-18 05:30  10-18 05:30  …
```

The async checks fact flips on a real pull request: this PR (#193), with a thread in this
worktree (`project add --path <this worktree>`, `thread new --project … --worktree …`,
no prompt). The gh poll first learns the branch's pull request, then the checks fetch
resolves:

```
06:18:14 code-foundry plugin.hello.show.checks: not available in this context: the thread has no pull request
06:18:19 code-foundry plugin.hello.show.checks: not available in this context: the thread has no pull request
06:18:24 code-foundry plugin.hello.show.checks: not available in this context: not known yet ("github-actions" in pr.checks.provider waits on a pull request's checks)
$ code-foundry plugin list --context-thread $T2
hello  …  demo(on) pinned(off) checks(on)
$ code-foundry pr checks --thread $T2
alexwaumann/code-foundry#193 https://github.com/alexwaumann/code-foundry/pull/193
NAME           STATUS       PROVIDER        STARTED      COMPLETED    URL
ci / frontend  in_progress  github-actions  10-18 06:18  -            https://github.com/…/actions/runs/39122670224/job/117661291536
…
$ code-foundry plugin surface hello checks --context-thread $T2
instance hello/checks/pr:alexwaumann/code-foundry#193: live
view version 2:          # the plugin's host/invoke of pr.checks, one row per Actions job
```

The plugin's log shows the host's side:

```
06:11:51.231 host       opened hello/demo/thread:s-47aac4538464
06:12:08.596 host       submit f-save on hello/demo/thread:s-47aac4538464 (version 7)
06:12:08.845 host       secret set from a form: token
06:12:15.451 host       click log-start on hello/demo/thread:s-47aac4538464 (version 9)
06:12:29.545 host       opened hello/pinned/thread:s-47aac4538464
```

## Open for PR 5 / 6

* GUI (PR 5): `api/plugin.ts` parses `view_json` (the `testdata/hello-demo` files are the
  three tab views of the demo: every node kind, tabs, fieldset, an `optionsSource:
  projects` select, time and duration spans, text and lines logs, a stored secret, a
  notice, empty states, and the inert thread and terminal nodes); the surface registry
  fall-through by `PluginSurface.kind`; availability from the show commands; re-list on
  `availability_epoch`; `ShowView panel.plugin.*` with its query; one `WatchSurface` per
  visible surface tab (state, cached view, appends, toasts, heartbeats); `Act` with the
  element's key and the form's values; host-side `command` (through `runCommand`, with
  the panel's context), `open_url` (`view.open.url`) and `copy`; form drafts per
  instance and tab; `UiIntent.InvokeCommand` → `runCommand`; `host_rendered` views; the
  mock daemon's plugin fixtures. `optionsSource` options are the GUI's to fill.
* The plugin is not told why an instance closed beyond `idle`; `context_gone` (a thread
  archived) and `unavailable` (its when clause turned false while open) from PRIMITIVES §C
  are not sent yet: an open instance stays open until its grace ends.
* PR 6: `thread` and `terminal` nodes are only validated; announce `view.node.thread` /
  `view.node.terminal` when they render.
* The checks cache refreshes by age (60 s); it does not listen to the gh poll's events
  (ARCHITECTURE §C.5 suggested invalidating on them).
* `pr` scope: two threads on one pull request share an instance; the instance's context
  is the first opener's project.
