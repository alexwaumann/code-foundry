# Plugins: release readiness (2026-10-18)

The final integration run of the whole plugin chain (13 stacked PRs, all open) and what
stands between it and a release. Run on the top of the chain, `cf/plugins-12-renderer-defects`
(#205, base `705c44e2`), with an isolated home `~/.cf-final`, the three plugins from the
real registry (`alexwaumann/code-foundry-plugins`: gh-actions 0.1.1, test-watcher 0.1.1,
showcase 0.1.1), driven from the CLI and from the GUI (Playwright WebKit). Three defects
were found and fixed on this branch (below); everything else passed.

## (a) The chain and how to merge it

In merge order (each PR's base is the one above it; #191's is `main`):

| # | PR | Branch | What it adds |
|---|---|---|---|
| 1 | #191 | `cf/plugins-1-core` | daemon plugin store, `pluginsdk` nested module, secrets store, dynamic commands, `PluginService`, `plugin.*` verbs, hello + python examples |
| 2 | #193 | `cf/plugins-2-surfaces` | surface instances, view validation, predicates and facts (async `pr.checks`), `plugin surface` / `plugin act` |
| 3 | #192 | `cf/plugins-3-events-flags-env` | event subscriptions, thread flags (sidebar, line 2, dock), session environment hook |
| 4 | #197 | `cf/plugins-4-skill` | the `code-foundry-plugin` skill and its reference files |
| 5 | #198 | `cf/plugins-5-gui` | GUI renderer for every node, consent dialog, Settings → Plugins (Installed) |
| 6 | #199 | `cf/plugins-6-thread-terminal` | plugin-owned threads and terminals end to end |
| 7 | #196 | `cf/plugins-7-registry` | registries, install / update / uninstall / dev, Browse |
| 8 | #200 | `cf/plugins-8-secrets` | secrets isolation and install hardening (origin binding, per-home Keychain service) |
| 9 | #201 | `cf/plugins-10-host-gaps` | close reasons, command errors, CLI ergonomics (`--settle`, act presses commands), limits, `secret/changed`, `terminal/read` |
| 10 | #203 | `cf/plugins-11-gui-gaps` | flag click-through, header flag chip, secrets in Settings, install errors, real paths, empty Browse |
| 11 | #202 | `cf/plugins-13-skill-touchup` | skill touch-up from the showcase and plugin-fix rounds |
| 12 | #204 | `cf/plugins-9-fuzz` | fuzz targets and the 23 bugs they found |
| 13 | #205 | `cf/plugins-12-renderer-defects` | renderer defects from the showcase pass (stream budget), this run's fixes and this note |

**Merge bottom-up**, one PR at a time, with plain merge commits (`gh pr merge N --merge`,
default subject), never merging `main` into a branch:

1. `gh pr merge 191 --merge` (base `main`). Do not delete `cf/plugins-1-core` yet.
2. `gh pr edit 193 --base main`; its diff is now its own commits only. Wait for its checks
   on the head sha (the `local-check` attestation is already there; CI skips when it is),
   then `gh pr merge 193 --merge`.
3. Repeat for #192, #197, #198, #199, #196, #200, #201, #203, #202, #204, #205, in that
   order: retarget to `main`, checks green on the head sha, merge.
4. Delete the merged branches only after the PR above each one has been retargeted
   (deleting a base branch with an open PR on it closes or retargets that PR).
5. Tag the SDK on `main`'s final merge commit:
   `git tag pluginsdk/v0.1.0 <sha> && git push origin pluginsdk/v0.1.0`
   (the nested module's tag must carry the `pluginsdk/` prefix).
6. The three plugin repositories, each: `go get github.com/alexwaumann/code-foundry/pluginsdk@v0.1.0`,
   change the surface's `Close()` to `Close(pluginsdk.CloseReason)` (#201; one line:
   gh-actions `surface.go:279`, test-watcher `surface.go:71`, showcase `gated.go:64` and
   `gallery.go:214`), `go mod tidy` (showcase's `go.mod` wrongly marks the SDK `// indirect`),
   version 0.1.2 in `plugin.json` and the `version` constant, tag `v0.1.2` (the release
   workflow builds and publishes), then a PR to `alexwaumann/code-foundry-plugins` bumping
   the three index entries (version, artifact URLs, sha256). This run compiled the showcase
   that way against this branch's SDK: `go vet`, `go test` and `make build` passed with only
   the `Close` change.
7. The shots branches (`cf/plugins-{3,5,6,7,11,12}-shots`, `cf/plugins-shots`,
   `cf/plugins-showcase-shots`, `cf/plugins-final-shots`) are not for merge.

## (b) The run

`code-foundry` below is `bin/code-foundry` of this branch with `CODE_FOUNDRY_HOME=~/.cf-final`
and every `CLAUDE*` variable unset (a wrapper script; see the integration note's "Run the
stack locally"). Daemon: `code-foundry daemon --dev` from that wrapper.

### 1. Build, registry, install, enable: pass

```
$ make build && make gui-build                      # exit 0
$ code-foundry daemon status
daemon pid 35996, version dev, up 3s, home /Users/alex/.cf-final
$ code-foundry plugin browse
no plugin registry is configured; add one with: code-foundry settings set plugins.registries https://github.com/<owner>/<repo>
$ code-foundry settings set plugins.registries https://github.com/alexwaumann/code-foundry-plugins
$ code-foundry plugin browse
NAME          VERSION  INSTALLED  PERMISSIONS                                                                                                                 DESCRIPTION
gh-actions    0.1.1    -          commands(pr.checks,thread.send,view.open.url) events(gh,threads) threadStatus                                               GitHub Actions runs, ...
showcase      0.1.1    -          commands(pr.checks,thread.send,view.open.url) events(gh,project,threads) threadStatus sessionEnv secrets threads terminals  Every plugin component ...
test-watcher  0.1.1    -          commands(thread.send) events(project,threads) threadStatus terminals                                                        Runs the project's tests ...
registry https://github.com/alexwaumann/code-foundry-plugins: 3 plugin(s), fetched 2026-10-18 14:15
$ code-foundry plugin install gh-actions          # likewise test-watcher, showcase
installed gh-actions 0.1.1 from https://github.com/alexwaumann/code-foundry-plugins
disabled until you enable it: code-foundry plugin enable gh-actions (lists its permissions)
$ code-foundry plugin enable showcase             # exit 2
code-foundry plugin.enable: Enable Showcase 0.1.1? It runs bin/showcase as you and may:
  - run Code Foundry commands: pr.checks, thread.send, view.open.url
  - read events: gh, project, threads
  - raise threads to needs-attention or error
  - add environment variables, PATH entries and directories to new Claude sessions
  - keep secrets in your Keychain (its own, under code-foundry-plugin)
  - start and drive its own Claude threads
  - open its own terminals
Re-run with --yes to confirm.
$ code-foundry plugin enable gh-actions --yes     # likewise the other two
enabled gh-actions 0.1.1 (starting)
commands: code-foundry plugin gh-actions rerun-failed, … rerun, … cancel, … send-failure, … open
$ code-foundry plugin list
NAME          VERSION  STATE    PERMISSIONS  COMMANDS  SURFACES
gh-actions    0.1.1    running  …            5         runs(off)
showcase      0.1.1    running  …            4         gallery(on) gated(off)
test-watcher  0.1.1    running  …            5         tests(off)
$ code-foundry plugin logs gh-actions
14:15:42.911 host       starting gh-actions 0.1.1 (pid 36514)
14:15:43.001 host       running
14:15:43.002 log info   gh-actions is up dev=false host=dev
14:15:43.002 host       subscribed sub-1 to threads, gh
```

No warning or error in any plugin log or in the daemon's stderr for the whole run. The
released binaries (SDK commit `73685d8b`) run against this host unchanged.

### 2. gh-actions on PR #205: pass

```
$ code-foundry project add --path ~/projects/code-foundry.worktrees/plugins-12
registered code-foundry (b1080fe9fff5)
$ code-foundry thread new --project b1080fe9fff5 --worktree ~/projects/code-foundry.worktrees/plugins-12 --name 'Plugins final' --created-by ''
created thread Plugins final (s-ff48947872da) in /Users/alex/projects/code-foundry.worktrees/plugins-12
$ code-foundry plugin list --context-thread s-ff48947872da      # every 5 s
14:16:05 runs(off)   … 14:16:20 runs(off)
14:16:25 runs(unknown)                                          # branch linked to #205, checks being read
14:16:30 runs(on)
$ code-foundry plugin surface gh-actions runs --thread s-ff48947872da --settle 2s
instance gh-actions/runs/pr:alexwaumann/code-foundry#205: live
view version 2:
  header "#205 plugins 12: renderer defects …" 705c44e [queued]  ci #531 · queued <time>
  tabs: Runs (2)* | Jobs | Log;  bar: Cancel (plugin.gh-actions.cancel run=39157733486)
  runs: ci #531 queued (selected); ci #530 running
$ code-foundry plugin act gh-actions runs tab --key tab-jobs --thread s-ff48947872da
acted on tab-jobs (view version 2)
view version 3: … "active": "tab-jobs" … jobs-summary "No jobs yet", job-list [] "No jobs yet"
$ code-foundry plugin act gh-actions runs --key run-39157731542 …   # after tab-runs: select #530
  → Jobs: "1 running", attested running                       # later: #531 passed 5m14s, #530 cancelled
$ code-foundry plugin gh-actions send-failure --context-thread s-ff48947872da     # exit 1
code-foundry plugin.gh-actions.send-failure: no failed run for alexwaumann/code-foundry#205 at 705c44e
```

`runs(off)` for the first 20 s is the gh poll not having linked the branch to its pull
request yet (a scope `pr` clause is false without a pull request), then `unknown` while
`pr.checks` is read.

### 3. test-watcher on a scratch Go module: pass (after fix 1)

```
$ (cd ~/.cf-final/scratch/calc && git init …)        # Add/Mul and their tests, one commit
$ code-foundry project add --path ~/.cf-final/scratch/calc
registered calc (ed0ee1b5f074)
$ code-foundry thread new --project ed0ee1b5f074 --name 'Calc tests' --created-by ''
created thread Calc tests (s-2fa719e01882) in /Users/alex/.cf-final/scratch/calc
$ code-foundry plugin surface test-watcher tests --thread s-2fa719e01882 --settle 2s
  header calc [idle] main; tabs Status* | Failures | Output; Command go test ./... (detected)
$ sed -i '' 's/got != 5/got != 6/; s/want 5/want 6/' calc_test.go          # 6 s later:
  header calc [failing]; Failures (1)
$ code-foundry thread flags s-2fa719e01882
PLUGIN        LEVEL  REASON                  SET                  UNTIL SEEN
test-watcher  error  Tests failing: TestAdd  2026-10-18 14:17:37  yes
$ code-foundry plugin act test-watcher tests tab --key tab-output …
  {"terminal": {"terminalId": "t-e104f4022552", "title": "go test ./..." …}}
$ code-foundry plugin act test-watcher tests tab --key tab-failures …
  {"key": "fail-0", "glyph": {"status": "failed"}, "title": "TestAdd", "line2": {"spans": [{"text": "example.com/scratch/calc", "mono": true}]}, …}
$ git checkout calc_test.go                                                  # 6 s later:
  header calc [passing]
$ code-foundry thread flags s-2fa719e01882
thread Calc tests (s-2fa719e01882) has no flags
$ code-foundry plugin logs test-watcher
14:17:37.001 log info   test run started command=go test ./... dir=…/calc run=1 terminal=t-e104f4022552
14:17:37.336 host       terminal t-e104f4022552 exited (1)
14:17:37.606 host       flag error on s-2fa719e01882: Tests failing: TestAdd
14:17:54.926 host       terminal t-16bfdb9b523c exited (0)
14:17:55.014 host       flag cleared on s-2fa719e01882
```

Toggle and command form:

```
$ code-foundry plugin act test-watcher tests --key f-watch --value false …   # before fix 1: toggled
  … "value": false …          then again --value false → "value": true (it toggled back)
$ code-foundry plugin act test-watcher tests --key f-watch --value false …   # after fix 1, ×2, then true ×2
set false -> "value": false / false / set true -> true / true
$ code-foundry plugin act test-watcher tests --key f-watch --value maybe …   # exit 2
code-foundry plugin.act: invalid argument: field "watch": want true or false
$ code-foundry plugin test-watcher toggle-watch --context-thread s-2fa719e01882
Watching for changes: off
$ code-foundry plugin act test-watcher tests --key save-command --values '{"command":"go test ./...\necho hi"}' …
acted on save-command (view version 16)    … "error": "the command must be one line" …
$ code-foundry plugin act test-watcher tests --key save-command --values '{"command":"go test -count=1 ./..."}' …
acted on save-command (view version 17)    … Command "go test -count=1 ./..."
$ code-foundry plugin test-watcher set-command --context-thread s-2fa719e01882 --command $'go test ./...\nx'   # exit 1
code-foundry plugin.test-watcher.set-command: the command must be one line
$ code-foundry plugin test-watcher set-command --context-thread s-2fa719e01882 --command ''
Test command reset to the detected go test ./...
```

### 4. showcase: pass (after fix 2)

```
$ for t in text data log forms status actions owned host; do code-foundry plugin act showcase gallery tab --key tab-$t; done
  every tab rendered (Text: sizes/spans/times/pills/markdown; Data: pairs, 5 lists incl. dense and empty, chips;
  Log: 3 logs; Forms: 13-field form + a command form; Status: progress, notices, empties, nested sections;
  Actions: every style, commands, open/copy; Owned: helper thread s-f6b9ed08ed6d + terminal t-66a6e1e5b266;
  Host: context, flags, toasts, gate, env, secrets, subscriptions, invoke)
$ code-foundry plugin showcase gate on --context-thread s-2fa719e01882
Gate on for e01882: the Gated tab is offered there
$ code-foundry plugin list --context-thread s-2fa719e01882    → gated(on);  plugin surface showcase gated → live
$ code-foundry plugin showcase gate off --context-thread s-2fa719e01882
$ code-foundry plugin surface showcase gated --thread s-2fa719e01882        # exit 2
code-foundry plugin.surface: failed precondition: showcase gated is not available here: its condition does not hold here: showcase.on
  (plugin log: closed showcase/gated/thread:s-2fa719e01882 (unavailable: its condition does not hold here: showcase.on))
$ code-foundry plugin act showcase gallery --key secret-save-btn --values '{"demo":"hunter2-final"}'
$ code-foundry plugin secrets list showcase
KEY   SET
demo  2026-10-18 14:21
$ code-foundry plugin act showcase gallery --key secret-read-btn   → "demo is set: 13 characters (value withheld)"
$ code-foundry plugin secrets delete showcase demo --yes
deleted secret demo of plugin showcase
$ code-foundry plugin act showcase gallery --key env-on-btn && code-foundry plugin env
plugin showcase
  scope: every project, and threads without a project
  env SHOWCASE_ENV
  env SHOWCASE_FROM
  PATH += /Users/alex/.cf-final/plugin-data/showcase/bin
  --add-dir /Users/alex/.cf-final/plugin-data/showcase/addon
$ code-foundry plugin env --json
{"environments":[{"plugin":"showcase", "env":[{"key":"SHOWCASE_ENV"}, {"key":"SHOWCASE_FROM"}], …}]}   # no values
$ code-foundry plugin threads showcase
s-f6b9ed08ed6d  idle  Showcase helper    no project  1m  (plugin:showcase)
s-4a595ca611e5  idle  Showcase narrator  no project  1m  (plugin:showcase)
$ code-foundry thread list --plugin showcase      # the same two
$ code-foundry thread list                        # only Calc tests and Plugins final
$ code-foundry plugin terminals showcase
t-66a6e1e5b266  running  showcase ticker  sh  /Users/alex/.cf-final/plugin-data/showcase
```

The released showcase is built on SDK `73685d8b`, which has neither `OnSecretChanged` nor
`ReadTerminal`; the host sends `secret/changed` and the old SDK ignores it. To see both,
a copy of the clone (`~/.cf-final/scratch/showcase`, the clone itself untouched) was built
against this branch's `pluginsdk` (a `replace`, the one-line `Close(pluginsdk.CloseReason)`
change twice, an `OnSecretChanged` that logs, and `ping` appending a `terminal/read` of the
ticker). That copy is also the `plugin dev` subject:

```
$ code-foundry plugin act showcase gallery --key secret-save-btn --values '{"demo":"before-takeover"}'
$ code-foundry plugin dev ~/.cf-final/scratch/showcase --follow=false            # exit 2
code-foundry plugin.dev: failed precondition: a plugin named showcase is installed at /Users/alex/.cf-final/plugins/showcase; --force replaces it with a link to /Users/alex/.cf-final/scratch/showcase
$ code-foundry plugin dev ~/.cf-final/scratch/showcase --follow=false --force    # exit 2, the consent dry run
… It replaces the plugin showcase from the registry https://github.com/alexwaumann/code-foundry-plugins: the consent you gave it, its 1 secret(s) in the Keychain and its data in /Users/alex/.cf-final/plugin-data/showcase will be deleted.
Re-run with --yes to confirm.
$ code-foundry plugin dev ~/.cf-final/scratch/showcase --follow=false --force --yes
linked /Users/alex/.cf-final/scratch/showcase as dev plugin showcase; enabled showcase 0.1.1 (starting)
$ code-foundry plugin secrets list showcase
plugin showcase has no secrets
$ code-foundry plugin logs showcase
14:25:12.594 host       taken over by the folder /Users/alex/.cf-final/scratch/showcase: deleted the consent you gave it, its 1 secret(s) in the Keychain and its data in /Users/alex/.cf-final/plugin-data/showcase
14:25:12.714 log info   showcase is up dev=true flags=0 host=dev
$ code-foundry plugin threads showcase       # the old package's threads, archived, still tagged (see "not fixed")
s-f6b9ed08ed6d  idle  Showcase helper    no project  4m  [archived]  (plugin:showcase)
# secret/changed, on the SDK that has it:
$ code-foundry plugin secrets delete showcase demo --yes
14:25:22.466 host       secret deleted by the user: demo
14:25:22.466 log info   secret/changed deleted=true key=demo
# terminal/read, from the Owned tab's ticker:
$ code-foundry plugin showcase ping
pong 1
terminal/read t-d1886c0d02ad (truncated false):
ticker in /Users/alex/.cf-final/plugin-data/showcase with SHOWCASE_TERM=ticker
tick   1  14:25:28
…
tick   5  14:25:32
```

Before fix 2, `plugin dev … --force` over the registry install answered "a plugin named
showcase is installed at …; remove it first" with or without `--force`, while `plugin
install <folder> --force` replaced it. (`plugin install <folder>` without `--force` was
refused the same way; with it, it took over: "warning: replaced plugin showcase from the
registry …: deleted the consent you gave it, its 1 secret(s) in the Keychain and its data".)

### 5. GUI: pass (after fix 3)

Frontend from this branch in Playwright WebKit (1280 × 800 at 2×) against the isolated
daemon, through Vite's dev server (`?daemon=…&token=…`; a production build ignores those
and asks the Wails host). Panel at 420 and 280 px. The only console error is the 404 of
`/wails/runtime` (no Wails host in a browser).

* gh-actions Runs and Jobs on the #205 thread; at 280 px too.
* test-watcher failing on "Calc tests 2": Failures (package on line 2) and Output (the live
  terminal node, "Process exited with code 1"); the sidebar row "Calc tests" reads
  "Test Watcher: Tests failing: TestAdd" in red, the bell at 1.
* Click-through: a click on that row opened "Calc tests" with the Tests tab in its panel
  (`data-surface="plugin.test-watcher.tests"`, `thread-pane` `s-2fa719e01882`).
* Header chip: test-watcher's flag is until-seen, so opening the thread clears it and the
  chip never shows it (by design of until-seen; see "Nice to have"). The chip is shot with
  showcase's persistent flag (`plugin showcase flag error --reason …`): "Showcase: Tests
  failing (raised by showcase, persistent)" in red with ×.
* showcase Owned, "Both (stress)": two thread nodes and the ticker; scrolled to them, the
  third live node shows Paused + Attach (`data-reason="budget"`); Attach on the terminal
  makes it live and pauses the oldest; acts after that answered 200 in 62–166 ms
  (`owned-refresh-btn`, `hdr-refresh`); no "Waiting for a connection" at 420 or 280.
* Settings → Plugins: Installed with real paths (`/Users/alex/.cf-final/scratch/showcase`,
  `from alexwaumann/code-foundry-plugins`), the session environment by name, the secret
  list ("demo set 10 min ago" with delete); Browse with the three entries; an update row
  staged with a loopback registry (`http://127.0.0.1:9491/index.json` listing test-watcher
  0.1.2 ahead of the real one: "Update from 0.1.1"); the no-registry state ("No registry
  configured. Add one in Registries").

Screenshots, branch `cf/plugins-final-shots` (base `705c44e2`, PNGs only):

![gh runs dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/gh-actions-runs-dark.png)
![gh runs light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/gh-actions-runs-light.png)
![gh jobs dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/gh-actions-jobs-dark.png)
![gh jobs light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/gh-actions-jobs-light.png)
![gh runs dark 280](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/gh-actions-runs-dark-280.png)
![gh runs light 280](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/gh-actions-runs-light-280.png)
![tests failing dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/test-watcher-failing-dark.png)
![tests failing light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/test-watcher-failing-light.png)
![tests output dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/test-watcher-output-dark.png)
![tests output light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/test-watcher-output-light.png)
![tests failing dark 280](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/test-watcher-failing-dark-280.png)
![tests failing light 280](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/test-watcher-failing-light-280.png)
![click-through dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/flag-click-through-dark.png)
![click-through light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/flag-click-through-light.png)
![flag chip dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/flag-chip-dark.png)
![flag chip light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/flag-chip-light.png)
![owned paused dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/showcase-owned-paused-dark.png)
![owned paused light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/showcase-owned-paused-light.png)
![owned attached dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/showcase-owned-attached-dark.png)
![owned attached light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/showcase-owned-attached-light.png)
![owned attached dark 280](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/showcase-owned-attached-dark-280.png)
![owned attached light 280](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/showcase-owned-attached-light-280.png)
![installed dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-installed-dark.png)
![installed light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-installed-light.png)
![browse dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-browse-dark.png)
![browse light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-browse-light.png)
![browse update dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-browse-update-dark.png)
![browse update light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-browse-update-light.png)
![no registry dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-no-registry-dark.png)
![no registry light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-final-shots/docs/notes/plugins-final/settings-no-registry-light.png)

### 6. Security spot-checks: pass

A 40-line python plugin (`~/.cf-final/scratch/secprobe`, permission `secrets`, linked with
`plugin dev`) forwarding `call <method> --key K` as `secret/<method>`, with showcase holding
`demo`:

```
own                  get -> ok: {"found": false}
../showcase/demo     get -> refused: {"code": -32602, "message": "secret key \"../showcase/demo\" must match ^[A-Za-z0-9._-]{1,128}$"}
showcase/demo        get -> refused (same)        ../../showcase/demo  get -> refused
/demo                get -> refused               %2Fshowcase%2Fdemo   get -> refused
a b, demo\nx, demo;rm  get -> refused
..                   get -> ok: {"found": false}  # a legal key, inside secprobe's own namespace
demo                 get -> ok: {"found": false}  # showcase's key name, not showcase's item
set own=probe-v → ok; get own → {"value": "probe-v", "found": true}
set / delete ../showcase/demo → refused;  list → [{"key": "own", …}]
$ code-foundry plugin secrets list showcase     → demo, untouched
$ code-foundry plugin install alexwaumann/code-foundry-plugin-gh-actions      # exit 2, before any download
code-foundry plugin.install: failed precondition: plugin gh-actions came from the registry https://github.com/alexwaumann/code-foundry-plugins, and a package from the releases of alexwaumann/code-foundry-plugin-gh-actions would inherit the consent you gave it; --force deletes them and starts it fresh (it asks for consent again), or run `code-foundry plugin uninstall gh-actions --purge` first
$ code-foundry plugin install test-watcher        # with the loopback registry first: another source
code-foundry plugin.install: failed precondition: plugin test-watcher came from the registry https://github.com/alexwaumann/code-foundry-plugins, and a package from the registry http://127.0.0.1:9491/index.json would inherit …
$ code-foundry plugin update test-watcher       → every plugin is up to date   (no cross-registry update)
$ code-foundry plugin env [--json]              → names only (above)
$ security find-generic-password -a showcase/demo   → "svce"="code-foundry-plugin-3b2938e85d45"; nothing under the plain service
```

### Fixes made in this run (on #205)

1. **`plugin act --value` on a toggle did the opposite half the time** (`594ee50d`). The
   act's `value` is a string on the wire (`SurfaceActRequest.value`); the GUI sends it and
   the form's `values` (a toggle as a boolean), the CLI only the string. test-watcher reads
   `act.Value.(bool)` (never true on the wire), then `act.Values["watch"]`, else toggles,
   so every CLI act flipped the switch. The host now adds a change's value to its values
   under the field's name, typed by the control (`"false"` → false, a multi select's
   `a,b` → a list), unless the values carry it already; a value the control cannot take is
   refused ("want true or false"). `withChange` in `internal/store/plugin/surface_act.go`,
   `TestChangeValueJoinsValues`.
2. **`plugin dev --force` could not replace an installed package** (`cc790c1b`): "remove
   it first" with or without `--force`, although its help says it takes the name from
   another source and `plugin install <folder> --force` does. It now refuses without
   `--force` naming the flag, and with it goes through the origin takeover (consent text,
   secrets, data and consent deleted) and replaces the package with the link (shared
   `linkOverPackage` in `install.go`). `TestDevOverAnInstalledPackage`.
3. **A paused thread or terminal node painted over the surface's sticky header and view
   tabs** when scrolled under them (`d4df73d6`): `LivePaused` is `absolute inset-0 z-10`,
   the sticky header is `z-10` too and earlier in the DOM. The thread and terminal nodes
   are now `isolate`, so the overlay's z-index stays inside its node. Seen on the showcase
   Owned tab after Attach at 420 and 280 px (header and tabs blank, `elementFromPoint` on
   the title returned `plugin-live-paused`); a renderer test checks the class.

## (c) Fixed before release

Every gap in `docs/notes/plugins-integration.md`'s "Known gaps" that is now fixed:

| Gap | Fixed in |
|---|---|
| `surface/close` only `idle`; state lost 60 s after the last viewer | #201 (`context_gone`, `unavailable`, idle grace 10 min, `Surface.Close(reason)`) |
| Plugin command errors as Connect `Unknown`; a down plugin's command fails as a usage error | #201 (`CommandFailed`, exit 1, "plugin X is crashed …; it retries in 1s") |
| `plugin list` shows a waiting clause as `off` | #201 (`unknown`) |
| No `plugin surface --settle`; `plugin act` prints only the version, cannot press command buttons | #201 |
| No event when a secret is deleted | #201 (`secret/changed`; consent never changes under a running plugin) |
| Command args in views have no limit | #201 (16 args, 4 KiB, 2 KiB a value; act values 64 KiB) |
| Every `host/invoke` is an info log line | #201 (debug on success) |
| `laterMethods` dead code | #201 |
| Direct `owner/repo` installs get no update offers | #201 |
| Form field builders lack `With…`; `SetContext` values `any` | #201 (`With…` helpers, `SetContextString/Bool/Int/Strings`) |
| Plugin terminals unreadable, no exit event | #201 (`terminal/read`, `terminal/exited`) |
| Secrets from an isolated home land in the real home's Keychain namespace | #200 (a Keychain service per non-default home; reads gated by this home's database) |
| No click-through from a flagged sidebar row; thread header shows no flags | #203 |
| Plugin secrets not in Settings | #203 |
| An install failure stays under its Browse row | #203 (dismiss ×, cleared by the next attempt) |
| Settings and the uninstall dialog say `~/.code-foundry/plugins` whatever the home | #203 (real `plugins_dir` / `data_dir`) |
| `dense` lists hiding `line2` undocumented | integration run (skill + SDK doc); #202 |
| Skill gaps from the showcase and plugin-fix rounds (24 + 8 items) | #202 |
| gh-actions: a tie picked the older cancelled run | gh-actions 0.1.1 (newest first, id tie-break) |
| test-watcher: Failures `dense` hid packages; Output not a terminal node | test-watcher 0.1.1 (seen in this run: package on line 2, Output a terminal) |
| Renderer defects from the showcase pass (17, incl. the stream budget hang) | #205 |
| `plugin act --value` on a toggle; `plugin dev --force` over a package; paused node over the header | #205 (this run) |

## (d) Deliberately not fixed

| Gap | Why |
|---|---|
| gh event cadence: gh events fire only on a poll change, the poll slows to 15 min without a GUI, `pr.checks` refreshes by age (60 s), `threadList` has no PR fields | Covered by the planned granular gh store events (per-PR lifecycle and detail-diff events, `gh-granular-events-plan`); patching the plugin bridge first would be redone there |
| No per-file worktree events (plugins poll fingerprints) | FSEvents per thread worktree exists in the project store; exposing it to plugins is a feature, not a fix |
| Keychain items readable by any process of the user without a prompt | Items trust `/usr/bin/security`, which the daemon writes through. A daemon-only ACL needs Security.framework and a signed binary (an unsigned binary's ACL breaks on every update). Revisit when the binary is signed |
| A running thread keeps the environment it spawned with | Needs a thread `started_at` and a "restart to pick up" affordance; the static line in Settings says so |
| Bottom-panel shells get no session environment | The environment hook is for Claude sessions; shells are the user's |
| A plugin terminal opened in the bottom panel is window-local, forgotten on reload | Bottom-panel persistence is its own feature (owner labels already exist) |
| Usage counts plugin threads but does not group them by plugin; no cost column in `plugin threads` | Usage page change, not plugin correctness |
| No signing of registry packages | Trust v1 = registry owner + sha256 + consent (DECISIONS); signing comes with binary signing |
| No byte progress for `gh` downloads | `gh release download` reports none; the phases are shown |
| `api` plugins can manage other plugins (delete secrets, enable, install) | The API cannot tell a plugin from the user (same uid, token file readable, socket needs none); the consent text says so |
| Threads of a plugin taken over with `--force` keep the owner tag `plugin:<name>` (archived), so the new package can list and send into them | Needs a thread store `Reown`; low risk (the user forced the takeover, the threads are archived); seen in this run |
| Form patterns run in JavaScript's backtracking `RegExp` (ReDoS) | Restricted instead (#204 #22: no nested quantified groups, 256 characters); a real fix is RE2 in the daemon or a worker with a timeout |
| Nothing watches `plugins/` or a dev plugin's folder | `plugin reload` / `plugin restart`; FSEvents for it is a nicety |
| `~/.claude.json` trust writes from isolated homes | Claude Code's file; the daemon pre-trusts thread cwds there whatever the home |
| No scrollback read for plugin terminals | `terminal/read` is the screen; the scrollback needs an emulator method on the terminal actor; `tee` documented |
| Plugin-side event drops (SDK notification cap) are not resynced | Blocking the reader would deadlock handlers that call the host |
| Duplicate field names across two forms collide on an outside click | Only names within one form are refused; rare |
| Registry: no search/filter, no manifest preview before install | Three plugins; consent shows the permissions before anything runs |
| `plugin list` has no per-command availability column | Only surfaces show `unknown` |

## (e) Bugs found by fuzzing (#204)

| # | Severity | Bug |
|---|---|---|
| 1 | high | Non-UTF-8 stderr reached log lines and the last error; protobuf refused them, so `PluginService.List` and `plugin logs` failed |
| 2 | high | Empty chips/pairs/actions/section/form/list encoded as `null`; the GUI read arrays and the panel broke |
| 3 | medium | Concurrent `thread/create` / `terminal/create` raced past the per-plugin limits (100 threads for 32) |
| 4 | medium | The `view/append` ring held up to 1 GiB per surface instance |
| 5 | medium | The incoming notification queue was unbounded |
| 6 | medium | One goroutine per incoming request, unbounded |
| 7 | medium | A result over the line limit was never sent; the caller waited out its timeout |
| 8 | medium | PAX/GNU meta headers let a ~10 MB tarball decompress ~10 GB before consent |
| 9 | medium | A FIFO `plugin.json` blocked discovery forever with the operation lock held |
| 10 | medium | A manifest arg default that does not parse made the registry refuse every command of the plugin |
| 11 | low | A message with a wrong-typed field was dropped: no answer, the call waited for its timeout |
| 12 | low | `Validate` wrote one message per problem: 193 MB and 390 ms for a hostile 1 MiB view |
| 13 | low | The SDK accepted invalid UTF-8 the daemon then refused as over a limit |
| 14 | low | A secret input's `store` could hold `:`, so every submit failed |
| 15 | low | Two fields of one name in a form silently shadowed each other |
| 16 | low | An oversize act stored its secret before being refused |
| 17 | low | A release URL tag or asset starting with `-` reached `gh` as a flag |
| 18 | low | 100 000 malformed env keys: 100 000 issues logged, answered and kept |
| 19 | low | Cleared `context/set` scopes and megabyte thread ids were kept |
| 20 | low | `thread/create` prompt unbounded; empty argv strings free |
| 21 | medium | A plugin named `0` or `1password` with surfaces never got its show commands |
| 22 | medium | A nested-quantifier `input.pattern` could freeze the GUI (ReDoS); now refused |
| 23 | medium | Session env keys that load code (`DYLD_*`, `LD_*`, `NODE_OPTIONS`, …) were accepted |

## (f) Security findings (#200)

| # | Attack | Result |
|---|---|---|
| 1 | `secret/*` with `../other/key`, `other/key`, `/x`, `%2F`, empty, unicode, 129 chars, `\0`, `\n`, spaces, quotes | Already safe at the protocol, now also enforced at the Keychain sink (re-checked live in this run) |
| 1b | Account collision `<plugin>/<key>` | Already safe, now a tested invariant |
| 1c | `security -i` command injection through a key or service | Fixed (defence in depth): one word of the safe charset only |
| 1d | An isolated home's plugin reads or overwrites the real home's items | Broken → fixed: a Keychain service per non-default home (seen in this run: `code-foundry-plugin-3b2938e85d45`) |
| 1e | A stale item readable by a new plugin of the same name | Broken → fixed: reads only keys recorded in this home's database |
| 2 | Name takeover by another repository, registry, folder, or a reinstall from elsewhere inherits consent, secrets and data | Broken → fixed: bound to the install source; `--force` deletes them and asks again (re-checked live) |
| 2b | `plugin update` silently switching registries | Broken → fixed (re-checked live with a loopback registry) |
| 2c | A package replaced by hand inside `plugins/<name>` | Accepted (writing there already means running as the user) |
| 3 | `api` plugin managing other plugins | Accepted, documented in the consent text |
| 3b | Any RPC returning a secret value | Already safe |
| 4a | Value in argv / `ps` | Already safe (`security -i`, hex on stdin); argv test added |
| 4b | Value in `security` errors or history | Already safe |
| 4c | Logs, `plugin logs`, events, act log | Already safe (keys only) |
| 4d | Session env values shown by `plugin env`, `PluginService.Environment`, Settings | Broken → fixed: names only (re-checked live) |
| 4e | Session env and plugin thread env in SQLite | Accepted (0600 home, needed to respawn) |
| 4f | Form secrets GUI → daemon | Already safe |
| 4g | A plugin leaking its own secret | Accepted; the skill says not to |
| 4h | `plugin act --values '{"token": …}'` in shell history | Accepted (the GUI is the way) |
| 5 | Keychain ACL | Accepted, documented: any process of the user can read the items without a prompt |
| 6a | `host/invoke` globs reaching `plugin.*` | Already safe |
| 6b | Tarball extraction (zip-slip, links, devices, FIFOs, setuid, bombs) | Already safe; rows added |
| 6c | `plugin dev` outside home through a symlink | Already safe |
| 6d | Data dir mode | Already safe (0700) |
| 6e | Reserved session env keys by case | Broken → fixed |
| 6f | cwd / addDirs / pathPrepend through a symlink pointing outside home | Broken → fixed |
| 6g | `terminal/create` argv injection | Already safe |
| 6h | View size, line length | Already safe |
| 6i | Request / notification floods | Broken → fixed (64 in flight, 4096 queued) |
| 6j | A plugin that never answers | Already safe |

## (g) Before release

### Must do

1. **Alex reviews the stack**, then merge it bottom-up as in (a), CI or attestation green on
   each head sha. Nothing in this run is failing.
2. **Tag `pluginsdk/v0.1.0`** on `main`'s final merge commit. Until then plugins pin a
   commit, `@main` has no `pluginsdk`, and a daemon built from an unpushed commit pins a
   commit `go get` cannot fetch (the skill's scaffold step).
3. **Re-release the three plugins as 0.1.2** on the tag: SDK bump, the one-line
   `Close(pluginsdk.CloseReason)` (two in showcase), `go mod tidy`, version in `plugin.json`
   and the constant, tag, release workflow; then the registry PR bumping the three index
   entries. Then install 0.1.2 from the registry into a release build once (the same
   steps 1–4) before announcing.
4. **Default registry: decided, empty.** Alex chose an empty `plugins.registries` by
   default (DECISIONS.md records it); the release notes must carry the `settings set` line
   for `https://github.com/alexwaumann/code-foundry-plugins`.
5. **Release notes / docs**: what plugins are, the consent model, the registry setting,
   `plugin install showcase` as the tour, that secrets live in the login Keychain readable
   by any process of the user (until signing), and that plugins run as the user.

### Nice to have after

* test-watcher's flag is until-seen, so opening the failing thread clears it and the
  header chip never shows it while tests still fail; a persistent error flag (it already
  clears on pass) would keep the chip (plugin change, 0.1.3).
* Browse shows "Update from 0.1.1" for another registry's entry of an installed name,
  which `plugin install`/the Update button then refuses as a takeover and `plugin update`
  ignores; Browse should offer updates only from the install's own registry (seen with the
  loopback registry). Done: `docs/notes/plugins-browse-offer.md`.
* Consent text says "under code-foundry-plugin" for every home; an isolated home writes
  under `code-foundry-plugin-<hash>` (cosmetic; the text is the SDK's static line).
* `plugin dev` checks for an installed package before the install-source binding, so
  without `--force` it names the package, not what would be inherited (the dry run with
  `--force` says it).
* `plugin uninstall` of a dev link says "removed …/plugins/showcase" (it removed the link
  only; the plugin-fix round's item g).
* `settings set plugins.registries ''` is refused as a missing value; `settings reset` is
  the way (help could say so).
* gh-actions' Jobs tab says "No jobs yet" twice (summary text and the list's empty text)
  for a queued run.
* No CLI to read a terminal's screen (`terminal/read` is plugin-only); a `terminal read`
  verb would help debugging.
* The skill could mention that a change act's `value` is a string and the field's typed
  value is in `act.Values` (now always present).
* Everything in (d).

## Left in place

`~/.cf-final` (daemon stopped): the isolated home, the calc module, the showcase copy and
the secprobe plugin under `scratch/`. Outside it the run wrote: `/tmp/cff` (the wrapper),
`/tmp/cff-scripts`, `/tmp/cff-shots`, `/tmp/cff-pick`, `/tmp/cff-reg` and a few
`/tmp/cff-*.txt` / `/tmp/cf-final-build*.log`; `~/.claude.json` trust entries for
`~/.cf-final/plugin-data/showcase`, `~/.cf-final/scratch/calc` and this worktree (thread
spawns; the worktree's may predate the run); the Keychain items of service
`code-foundry-plugin-3b2938e85d45` were deleted at the end. No message was sent to any
thread (no transcripts, no cost).
