# Plugins: the integration run (2026-10-18)

The last step of the plugin stack (`docs/sketches/plugins/DECISIONS.md`: "The series ends
with both plugins installed from the registry into a real daemon + GUI run and screenshots
of them working"). Both real plugins, `gh-actions` and `test-watcher`, installed from the
real registry (`alexwaumann/code-foundry-plugins`, both at 0.1.0; the default registry
when this ran) into a dev build of `cf/plugins-7-registry` with an isolated home, driven
from the CLI and from the GUI. Every step passed; two small fixes landed on this branch
(below). Since the rebase onto main (2026-10-18) `plugins.registries` defaults to empty,
so a run sets it first (the second line of `plugin browse` below).

## Run the stack locally

```
git fetch origin && git checkout cf/plugins-7-registry      # the top of the stack
make build && make gui-build                                # bin/code-foundry, gui/bin/Code Foundry
mkdir -p ~/.cf-integ                                        # an isolated home, under ~ (see below)
# a wrapper so no CLI call ever reaches the real home (a CLI call auto-starts a daemon):
printf '#!/bin/zsh\nexport CODE_FOUNDRY_HOME=$HOME/.cf-integ\nexec %s/bin/code-foundry "$@"\n' "$PWD" > /tmp/cf && chmod +x /tmp/cf
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT CODE_FOUNDRY_HOME=$HOME/.cf-integ ./bin/code-foundry daemon --dev &
/tmp/cf plugin browse                                       # "no plugin registry is configured": none by default
/tmp/cf settings set plugins.registries https://github.com/alexwaumann/code-foundry-plugins
/tmp/cf plugin browse                                       # the real registry: gh-actions, test-watcher
/tmp/cf plugin install gh-actions && /tmp/cf plugin install test-watcher
/tmp/cf plugin enable gh-actions --yes && /tmp/cf plugin enable test-watcher --yes
/tmp/cf plugin list
```

(Started from a Claude Code session, unset every `CLAUDE*` variable, not only the two
shown.) The home must be under `~`: `project add` refuses other paths, and a plugin's data
dir must be under home to be a thread's cwd or add-dir (PR 6). The GUI the same way PRs
5 to 7 shot it: the frontend in Playwright WebKit against that daemon, not the Wails
window (an isolated Wails copy shares the installed app's WebKit localStorage):

```
cd gui/frontend && pnpm exec vite --port 9461 --strictPort --host 127.0.0.1 &
# open http://127.0.0.1:9461/?daemon=http%3A%2F%2F127.0.0.1%3A<~/.cf-integ/daemon.port>&token=<~/.cf-integ/daemon.token>
```

To use the built app instead (it shares that WebKit storage, so put panel state back
afterwards): `CODE_FOUNDRY_HOME=~/.cf-integ CODE_FOUNDRY_BIN=$PWD/bin/code-foundry "gui/bin/Code Foundry"`.

## Transcript (`code-foundry` = the branch binary with `CODE_FOUNDRY_HOME=~/.cf-integ`)

### 1. Daemon and skills

```
$ code-foundry daemon status
daemon pid 51342, version dev, up 4s, home /Users/alex/.cf-integ
$ ls ~/.cf-integ/claude/.claude/skills
code-foundry-help  code-foundry-orchestrate  code-foundry-plugin
```

### 2. Install from the real registry

(Recorded while that registry was the default; today `code-foundry settings set
plugins.registries https://github.com/alexwaumann/code-foundry-plugins` comes first.)

```
$ code-foundry plugin browse
NAME          VERSION  INSTALLED  PERMISSIONS                                                                    DESCRIPTION
gh-actions    0.1.0    -          commands(pr.checks,thread.send,view.open.url) events(gh,threads) threadStatus  GitHub Actions runs, jobs and failed-step logs for the se...
test-watcher  0.1.0    -          commands(thread.send) events(project,threads) threadStatus                     Runs the project's tests in a thread's worktree whenever ...
registry https://github.com/alexwaumann/code-foundry-plugins: 2 plugin(s), fetched 2026-10-18 09:53
$ code-foundry plugin install gh-actions
installed gh-actions 0.1.0 from https://github.com/alexwaumann/code-foundry-plugins
disabled until you enable it: code-foundry plugin enable gh-actions (lists its permissions)
$ code-foundry plugin install test-watcher
installed test-watcher 0.1.0 from https://github.com/alexwaumann/code-foundry-plugins
disabled until you enable it: code-foundry plugin enable test-watcher (lists its permissions)
$ code-foundry plugin enable gh-actions
code-foundry plugin.enable: Enable GitHub Actions 0.1.0? It runs bin/gh-actions as you and may:
  - run Code Foundry commands: pr.checks, thread.send, view.open.url
  - read events: gh, threads
  - raise threads to needs-attention or error
Re-run with --yes to confirm.
$ code-foundry plugin enable gh-actions --yes
enabled gh-actions 0.1.0 (starting)
commands: code-foundry plugin gh-actions rerun-failed, code-foundry plugin gh-actions rerun, code-foundry plugin gh-actions cancel, code-foundry plugin gh-actions open
$ code-foundry plugin enable test-watcher --yes
enabled test-watcher 0.1.0 (starting)
commands: code-foundry plugin test-watcher run, code-foundry plugin test-watcher stop, code-foundry plugin test-watcher set-command, code-foundry plugin test-watcher toggle-watch
$ code-foundry plugin list
NAME          VERSION  STATE    PERMISSIONS                                                                    COMMANDS  SURFACES    NOTE
gh-actions    0.1.0    running  commands(thread.send,view.open.url,pr.checks) events(gh,threads) threadStatus  4         runs(off)
test-watcher  0.1.0    running  commands(thread.send) events(project,threads) threadStatus                     4         tests(off)
$ code-foundry plugin logs gh-actions --lines 20
09:53:56.226 host       installed 0.1.0 from https://github.com/alexwaumann/code-foundry-plugins
09:53:57.071 host       enabled with consent to: run Code Foundry commands: pr.checks, thread.send, view.open.url; read events: gh, threads; raise threads to needs-attention or error
09:53:57.073 host       starting gh-actions 0.1.0 (pid 51391)
09:53:57.183 host       running
09:53:57.183 log info   gh-actions is up dev=false host=dev
09:53:57.183 host       subscribed sub-1 to threads, gh
```

test-watcher's log is the same shape (`subscribed sub-1 to threads, project`). Neither
log had an error or warning for the whole run, nor did the daemon's.

### 3. gh-actions on this pull request (#196)

```
$ code-foundry project add --path ~/projects/code-foundry.worktrees/plugins-7
registered code-foundry (b1080fe9fff5)
$ code-foundry thread new --project b1080fe9fff5 --worktree ~/projects/code-foundry.worktrees/plugins-7 --name 'Plugins integration' --created-by ''
created thread Plugins integration (s-c8c441f08381) in /Users/alex/projects/code-foundry.worktrees/plugins-7
$ code-foundry plugin list --context-thread s-c8c441f08381     # every 5 s
09:54:12 gh-actions … runs(off)
…
09:54:38 gh-actions … runs(on)                                  # 26 s: the gh poll found #196, then its checks
$ code-foundry plugin surface gh-actions runs --thread s-c8c441f08381
instance gh-actions/runs/pr:alexwaumann/code-foundry#196: live
view version 1:      # "Loading": the header with the pull request link only
$ code-foundry plugin surface gh-actions runs --thread s-c8c441f08381
view version 2:
  header: "#196 plugins 7: registries, install, update, uninstall" 06b6e1c [cancelled]  ci #506 · took 2s · <time>
  tabs: Runs (2) | Jobs | Log
  bar: Rerun failed (plugin.gh-actions.rerun-failed run=39137758970), Rerun all
  runs: ci #506 cancelled 2s (selected); ci #507 passed 14s
elements: hdr-open (open_url …/actions/runs/39137758970), hdr-refresh, runs, jobs, log,
          btn-rerun-failed, btn-rerun (command), run-39137758970, run-39137760005 (click select-run)
$ code-foundry plugin act gh-actions runs --key run-39137760005 --thread s-c8c441f08381
acted on run-39137760005 (view version 4)
  → tab Jobs; header ci #507 [passed]; jobs: attested passed 9s, go-test / go-lint / frontend skipped
```

### 4. test-watcher on a scratch Go module

```
$ (cd ~/.cf-integ-scratch/calc && git init && …)   # calc.go Add/Mul, calc_test.go TestAdd/TestMul, one commit
$ code-foundry project add --path ~/.cf-integ-scratch/calc
registered calc (9b76780009b5)
$ code-foundry thread new --project 9b76780009b5 --name 'Calc tests' --created-by ''
created thread Calc tests (s-818df2d00f9d) in /Users/alex/.cf-integ-scratch/calc
$ code-foundry plugin surface test-watcher tests --thread s-818df2d00f9d
header: calc [idle] no run yet;  tabs: Status* | Failures | Output
  Command: go test ./... (detected); Last run: none yet; Changed since: none
$ sed -i '' 's/got != 5/got != 6/; s/want 5/want 6/' calc_test.go     # 2 s later:
header: calc [failing] … main;  tabs: Status* | Failures(1) | Output
$ code-foundry thread flags s-818df2d00f9d
PLUGIN        LEVEL  REASON                  SET                  UNTIL SEEN
test-watcher  error  Tests failing: TestAdd  2026-10-18 09:55:57  yes
$ code-foundry plugin act test-watcher tests tab --key tab-failures --thread s-818df2d00f9d
  row: TestAdd (example.com/scratch/calc)
$ git checkout calc_test.go                                          # 2 s later:
header: calc [passing];  Failures: "All tests pass"
$ code-foundry thread flags s-818df2d00f9d
thread Calc tests (s-818df2d00f9d) has no flags
$ code-foundry plugin logs test-watcher
09:55:57.420 log info   test run started command=go test ./... dir=/Users/alex/.cf-integ-scratch/calc pid=54878 run=1
09:55:57.734 host       flag error on s-818df2d00f9d: Tests failing: TestAdd
09:55:57.734 log info   test run ended dir=/Users/alex/.cf-integ-scratch/calc exit=1 run=1 stopped=false
09:56:09.420 log info   test run started command=go test ./... dir=/Users/alex/.cf-integ-scratch/calc pid=55477 run=2
09:56:09.525 host       flag cleared on s-818df2d00f9d
09:56:09.525 log info   test run ended dir=/Users/alex/.cf-integ-scratch/calc exit=0 run=2 stopped=false
```

### 5. The skill, once more

A fresh plugin from the installed skill's example, following `SKILL.md` only:

```
$ mkdir -p ~/.cf-integ-scratch/code-foundry-plugin-pinger && cd $_
$ cp -R ~/.cf-integ/claude/.claude/skills/code-foundry-plugin/example/. .   # files 0644, dirs 0755
$ LC_ALL=C sed -i '' 's/minimal/pinger/g; s/Minimal/Pinger/g' plugin.json main.go main_test.go
$ go mod init github.com/alexwaumann/code-foundry-plugin-pinger
$ go get github.com/alexwaumann/code-foundry/pluginsdk@06b6e1c6f1c081c08ce935832631b4873ffe3882   # 47 s, first fetch
$ go mod tidy && go vet ./... && go test ./... && make build
ok  	github.com/alexwaumann/code-foundry-plugin-pinger	0.147s
$ code-foundry plugin dev "$PWD" --follow=false
code-foundry plugin.dev: Enable Pinger 0.1.0? It runs bin/pinger as you and asks for no permissions.
Re-run with --yes to confirm.                                           # exit 2
$ code-foundry plugin dev "$PWD" --follow=false --yes
linked /Users/alex/.cf-integ-scratch/code-foundry-plugin-pinger as dev plugin pinger; enabled pinger 0.1.0 (starting)
$ code-foundry plugin pinger hello Ada
Hello, Ada!
$ code-foundry plugin act pinger status --key greet --thread s-818df2d00f9d
code-foundry plugin.act: invalid argument: greet is a command action: the host runs it, not the plugin   # as documented
$ code-foundry plugin uninstall pinger --yes
uninstalled pinger (removed /Users/alex/.cf-integ/plugins/pinger)
```

No stumble. The one trap is the pin: it is the build's commit, so a daemon built from an
unpushed commit pins something `go get` cannot fetch (the skill's fallback `@main` has no
`pluginsdk` until the stack merges).

## Screenshots

Frontend in WebKit (Playwright, 1280 × 800 at 2×, panel at its default 420 px) against
the isolated daemon, dark and light. Branch `cf/plugins-shots` (PNGs only).

GitHub Actions tab on the #196 thread, Runs and Jobs (run #507 selected):

![runs dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/gh-actions-runs-dark.png)
![runs light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/gh-actions-runs-light.png)
![jobs dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/gh-actions-jobs-dark.png)
![jobs light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/gh-actions-jobs-light.png)

The empty side panel: the built-in surfaces, then the two plugin surfaces under the
divider (a plugin mark where the built-ins have their hotkey letter):

![surfaces dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/panel-surfaces-dark.png)
![surfaces light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/panel-surfaces-light.png)

Test Watcher failing (Failures and Output). Two threads work in the scratch module; the
one on screen has its until-seen flag cleared by being viewed, so the flagged row in the
sidebar is the other one ("Test Watcher: Tests failing: TestAdd" in red, the bell at 1):

![failing dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/test-watcher-failing-dark.png)
![failing light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/test-watcher-failing-light.png)
![output dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/test-watcher-output-dark.png)
![output light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/test-watcher-output-light.png)

Settings → Plugins: Installed (both running, "from alexwaumann/code-foundry-plugins") and
Browse (the real registry, both Installed):

![installed dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/settings-installed-dark.png)
![installed light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/settings-installed-light.png)
![browse dark](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/settings-browse-dark.png)
![browse light](https://raw.githubusercontent.com/alexwaumann/code-foundry/cf/plugins-shots/docs/notes/plugins-integration/settings-browse-light.png)

The hello plugin's Assistant tab was skipped (PR 6's shots cover it).

## Fixes made here

* **A `duration` span under a second read "took 0s"** (test-watcher's header for a 300 ms
  `go test`). It now shows tenths under a second ("0.3s", "<0.1s"); from 1 s on it is
  unchanged (GitHub's whole seconds stay "2s"). `elapsed` times keep whole seconds.
  `formatFixedDuration` in `gui/frontend/src/components/plugin/format.ts`. Belongs to PR 5.
* **`dense` lists hide `line2`** (PRIMITIVES.md: "24 px single-line rows"), but the skill
  said only "`dense` tightens rows", so test-watcher's Failures list sets `dense` and its
  package line never shows. The skill's `primitives.md` and the SDK's `ui.List.Dense` doc
  now say what dense drops. Belongs to PR 4 (skill) and PR 1 (SDK doc). The plugin itself
  is not changed here (its repository).

## What works

Everything the series promised, end to end on real data: registry browse, install with
hash check, consent, enable, both plugins running clean; gh-actions' async `pr.checks`
predicate flipping `runs(on)` 26 s after the thread appeared, its shared `pr` instance,
tabs, row selection, command buttons; test-watcher's worktree events + fingerprint poll,
live runs, the error flag raised and cleared, until-seen clearing by the viewed thread,
line 2 and the bell; the side panel's plugin rows, `ShowView`/palette show commands, view
tabs, Settings → Plugins (Installed + Browse + Registries); the skill's scaffold → `plugin
dev` loop.

## Known gaps (from the seven notes and this run, deduplicated)

**Host**

* `surface/close` only ever says `idle`; `context_gone` (thread archived) and
  `unavailable` (when clause turned false) are not sent (PR 2). A closed instance forgets
  its plugin-side state: gh-actions' selected run resets 60 s after the last viewer.
* The `pr.checks` fact refreshes by age (60 s), not on the gh poll's events; gh events
  fire only on a poll change and the poll slows to 15 min without a GUI; the `threadList`
  payload has no pull request fields; no per-file worktree events (plugins poll) (PRs 2, 4).
* Nothing watches `plugins/` or a dev plugin's folder: `plugin reload` / `plugin restart`
  (PR 1).
* A plugin's own command error reaches the CLI as Connect `Unknown` ("… (unknown)"); a down
  plugin's command fails like a usage error (exit 2) (PRs 1, 4).
* `plugin list` shows an async clause not known yet as `off`; `plugin surface` has no
  `--settle`; `plugin act` prints only the version and cannot press command buttons (PR 4).
* No event tells a plugin a secret was deleted or consent changed; command args in views
  have no limit of their own (PR 4).
* A running thread keeps the env it spawned with (no "restart to pick up"); bottom-panel
  shells get no session environment (PRs 3, 5, 6).
* Plugin threads' cwd pre-trust and every thread's trust write the real `~/.claude.json`,
  and secrets go to the login Keychain, even from an isolated home (PRs 2, 6; seen here).
* Every `host/invoke` is a host log line: gh-actions' sweep writes about three
  `host/invoke pr.checks` lines a minute (fine under the 1 MiB rotation, but noise).
* `host.go`'s `laterMethods` still lists methods that are live (dead code; the registry is
  checked first) (PR 3).
* Registry: no search/filter, no manifest preview before install, an install failure stays
  under its row until a retry or reload, direct `owner/repo` installs get no update offers,
  no signing, no byte progress for gh downloads (PR 7).
* Usage counts plugin threads but does not group them by plugin; no plugin column in
  `plugin threads` cost (PR 6).

**GUI**

* No click-through from a flagged sidebar row to the plugin's surface; the thread header
  does not show flags (PRs 3, 5).
* Plugin secrets (`plugin secrets list/delete`) are not in Settings (PR 5).
* A plugin terminal opened in the bottom panel is window-local and forgotten on reload (PR 6).
* Settings → Plugins and the uninstall dialog say `~/.code-foundry/plugins` whatever
  `CODE_FOUNDRY_HOME` is (cosmetic; only isolated homes see it).

**Skill and SDK**

* `pluginsdk` is not tagged: plugins pin a commit until `pluginsdk/v0.1.0` after the
  merge; before it `@main` has no `pluginsdk`, and a daemon built from an unpushed commit
  pins a commit `go get` cannot fetch. The first `go get` takes ~45 s (it downloads the
  parent module once) (PR 4, seen here).
* Form field builders have no `With…` helpers; `SetContext` values are `any` (PR 4).

**The two plugins** (their repositories; not changed here)

* gh-actions: two runs created in the same second keep the API's order, so the default
  selection fell on the older, cancelled #506 although #507 passed (`pickRun` takes
  `runs[0]` when nothing failed or runs; sort ties should break by run id).
* test-watcher: the Failures list is `dense`, so each failure's package (`line2`) is never
  shown; drop `dense` or move the package to `titleMeta`. Its Output tab could become a
  `terminal` node now that PR 6 renders them (its README says so).

## Merge order

Stacked, each PR based on the one before; it merges as one, top-down:

1. #196 `cf/plugins-7-registry` → `cf/plugins-6-thread-terminal`
2. #199 `cf/plugins-6-thread-terminal` → `cf/plugins-5-gui`
3. #198 `cf/plugins-5-gui` → `cf/plugins-4-skill`
4. #197 `cf/plugins-4-skill` → `cf/plugins-3-events-flags-env`
5. #192 `cf/plugins-3-events-flags-env` → `cf/plugins-2-surfaces`
6. #193 `cf/plugins-2-surfaces` → `cf/plugins-1-core`
7. #191 `cf/plugins-1-core` → `main`

Then tag `pluginsdk/v0.1.0` on main's merge commit and bump the two plugin repositories
off their commit pins. The shots branches (`cf/plugins-{3,5,6,7}-shots`, `cf/plugins-shots`)
are not for merge.

## Left in place

The isolated home `~/.cf-integ` (daemon stopped) and `~/.cf-integ-scratch` (the calc
module, the pinger scaffold). Outside them the run wrote `~/.claude.json` trust entries
for `~/.cf-integ-scratch/calc` and this worktree (thread spawns; the worktree's may predate the run); no transcripts (the test
threads never got a message) and no Keychain items.
