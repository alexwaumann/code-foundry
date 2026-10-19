# Plugins: uninstall and forced takeover remove the plugin's threads (2026-10-18)

Closes the last plugin isolation gap left by `docs/notes/plugins-8-secrets-hardening.md`
("Later": after a forced takeover the old package's threads were archived but still tagged
`plugin:<name>`, so the new package could list and send into them). Decision (Alex,
2026-10-18): disable archives, uninstall and takeover remove, through the existing removal.

## What changed

| Path | Threads | Terminals |
|---|---|---|
| `plugin disable`, permissions grown on a rescan | archived (unchanged); enabling again finds them with `Threads`, a send unarchives | closed |
| `plugin uninstall` (with or without `--purge`) | **removed** | closed |
| `plugin install --force` / `plugin install <folder> --force` / `plugin dev --force` taking the name from another source | **removed** | closed |
| package gone while the daemon runs (`Reload`) or while it was down (`Start`'s sweep) | archived (unchanged) | closed |

* **One removal.** `OwnedThreads.Remove` is the daemon adapter over `thread.Manager.Remove`,
  the call behind `ThreadService.Remove` / `thread.remove`: `Close` first (Claude stops,
  mid-turn too), the thread's shells killed and removed, the row and items deleted, usage
  moved to the retired ledger, `Removed` published (the GUI's threads store drops it from
  `byId` and `owned`), wake subscriptions forgotten. Claude's own transcript under
  `~/.claude/projects` stays, as for any removed thread.
* **Plugin store** (`internal/store/plugin`): `forget` (archive) and the new `discard`
  (remove) share `release` (terminals, session env, flags). `removeThreads` removes every
  thread of the owner, archived ones too, concurrently, bounded by the same 20 s as
  archiving, and returns the ids removed in creation order; the plugin log says "removed
  its threads: <ids>". `Uninstall` and `purgeIdentity` (a forced takeover) call `discard`;
  `UninstallResult`, `InstallResult` and `EnableResult` (Dev) carry `RemovedThreads`.
* **Threads count as inheritance.** `checkOrigin` counts the name's threads: a package
  from another source would inherit them, so threads alone (e.g. a package deleted by hand,
  its threads archived) make it a takeover that needs `--force`.
* **Words.** Refusal: "would inherit the consent you gave it, … and its 2 threads". Dev
  `--force` consent: "…: the consent you gave it will be deleted, and it removes its 2
  threads." Install warning and plugin log: "deleted … and removed its 2 threads".
  Uninstall confirm (CLI): "Uninstall plugin x? It removes its 2 threads; its data,
  secrets and consent stay (--purge deletes them)." and with `--purge` "… It removes its 2
  threads and deletes its data, …". The count comes from `ThreadService.List` with the
  owner filter (`RegisterPluginRegistry` takes a `PluginThreadLister`); no threads, no
  sentence. The Settings uninstall dialog adds "It removes its N thread(s)." from the
  threads store's `owned` list (a narrow selector returning the count).
* **Reports.** `removed_thread_ids` on `UninstallPluginResponse` (3), `InstallPluginResponse`
  (10) and `DevPluginResponse` (4); the CLI prints "removed its 2 threads: <ids>"
  (uninstall) and "removed the replaced plugin's threads: <ids>" (dev).

## Decisions

* **Startup sweep archives, conservatively.** A package that vanished while the daemon was
  down (manual `rm`) is not an uninstall: its threads are archived as before, and putting
  the package back (or the same source's reinstall) gets them back. `plugin uninstall
  <name> --purge` then removes them (the purge path works without a package when there are
  leftovers); a plain `uninstall` of a package that is gone still answers "no plugin"
  (unchanged).
* **Reload's "package gone" archives too**, for the same reason (a package moved aside by
  hand while the daemon runs).
* **Remove, not re-own.** plugins-8 sketched `Reown(from, to)`; removing through the
  existing path needs no new thread-store API and leaves nothing tagged.
* **Removal runs after the plugin is stopped** (it cannot create more meanwhile) and
  before the package goes; a removal that fails is logged and the rest go on (the result
  lists only the ids removed).

## Tests

* `internal/store/plugin/threads_remove_test.go`: one table over disable (archives), enable
  again (still there, still its own), uninstall, uninstall `--purge`, forced takeover via
  install (refusal names the threads first) and via dev (the dry run's consent says
  "removes its 2 threads"); each case has a thread mid-turn (busy) and an archived one,
  checks the reported ids, that the terminals are closed and that another plugin's and the
  user's threads are untouched. `TestThreadsAloneAreInherited`.
* `internal/store/thread/owner_test.go` `TestRemoveOwnedThreadMidTurn`: an owned thread
  waiting on a permission mid-turn (fake claude, `write-allow`): `Remove` kills its Claude
  (the pid is gone), forgets it, publishes `Removed`.
* `internal/command/commands_plugin_registry_test.go`: the confirm with 2 threads, with 1
  and `--purge`, and the removed ids in the message.
* `e2e/plugin-registry.spec.ts`: the dialog says "It removes its 1 thread." for hello (the
  mock's `s-hello-assistant`) and nothing about threads for test-watcher.

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=~/.cfptr`)

Daemon `./bin/code-foundry daemon --dev` without the session's `CLAUDE*` vars;
`threads.default_model claude-haiku-5-5[1m]`, effort medium; `plugins.registries
https://github.com/alexwaumann/code-foundry-plugins`. `$T` is a no-project user thread
(`s-063ac1544054`), `cf` the CLI with that home.

```
$ cf plugin install showcase && cf plugin enable showcase --yes
$ cf plugin surface showcase gallery --thread $T
$ cf plugin act showcase gallery tab --key tab-owned --context-thread $T
$ cf plugin threads showcase
s-2fd75dc9c537  idle  Showcase narrator  no project  3s  (plugin:showcase)
s-489e67adfa73  idle  Showcase helper    no project  3s  (plugin:showcase)
$ cf plugin uninstall showcase
code-foundry plugin.uninstall: Uninstall plugin showcase? It removes its 2 threads; its data, secrets and consent stay (--purge deletes them).
$ cf plugin act showcase gallery owned-ask --context-thread $T     # a Haiku turn in the helper
$ cf plugin uninstall showcase --yes
uninstalled showcase (removed /Users/alex/.cfptr/plugins/showcase)
removed its 2 threads: s-489e67adfa73, s-2fd75dc9c537
$ cf thread list --all
s-063ac1544054  idle  Plugin threads removal e2e  no project  21s
```

Takeover by a dev link: a scratch copy of the showcase clone (`cp -R
…/plugin-repos/code-foundry-plugin-showcase ~/cfptr-showcase`; the clone untouched),
showcase reinstalled from the registry and its Owned tab opened again.

```
$ cf plugin dev ~/cfptr-showcase --force --follow=false
… It replaces the plugin showcase from the registry https://github.com/alexwaumann/code-foundry-plugins: the consent you gave it and its data in /Users/alex/.cfptr/plugin-data/showcase will be deleted, and it removes its 2 threads.
$ cf plugin act showcase gallery owned-ask --context-thread $T
$ cf thread get s-2175a1253835 | sed -n 2p
status: busy (working)                                  # helper's claude running (pids 99083, 99084)
$ cf plugin dev ~/cfptr-showcase --force --yes --follow=false
linked /Users/alex/cfptr-showcase as dev plugin showcase; enabled showcase 0.1.2 (starting)
removed the replaced plugin's threads: s-2175a1253835, s-d1001f199e51
# no claude process with the showcase add-dir left; thread list --all: only $T
$ cf plugin logs showcase
host       removed its threads: s-2175a1253835, s-d1001f199e51
host       closed its terminals: 1
host       taken over by the folder /Users/alex/cfptr-showcase: deleted the consent you gave it and its data in /Users/alex/.cfptr/plugin-data/showcase and removed its 2 threads
```

Takeover back by the registry package (`plugin install showcase` refused first: "…would
inherit the consent you gave it, its data in … and its 2 threads; --force deletes them…"):

```
$ cf plugin install showcase --force --json   # selected fields
{'kind': 'registry', 'changed': True, 'warnings': ['replaced plugin showcase from the folder /Users/alex/cfptr-showcase: deleted the consent you gave it and its data in … and removed its 2 threads'], 'removedThreadIds': ['s-66bca193316f', 's-b8e53999b22f']}
```

Disable / enable again / purge:

```
$ cf plugin disable showcase && cf plugin threads showcase
s-e5e481103c28  idle  Showcase narrator  no project  3s  [archived]  (plugin:showcase)
s-08e157cc33f6  idle  Showcase helper    no project  3s  [archived]  (plugin:showcase)
$ cf plugin enable showcase --yes && cf plugin threads showcase     # same two, still its own
$ cf plugin uninstall showcase --purge
code-foundry plugin.uninstall: Uninstall plugin showcase? It removes its 2 threads and deletes its data, its secrets in the Keychain, its logs and the consent given.
$ cf plugin uninstall showcase --purge --yes --json
{"removed":"/Users/alex/.cfptr/plugins/showcase","purged":["its data in /Users/alex/.cfptr/plugin-data/showcase","its logs","its consent and settings"],"removedThreadIds":["s-08e157cc33f6","s-e5e481103c28"]}
```

Startup sweep: showcase installed, threads created, daemon stopped (SIGTERM),
`rm -rf ~/.cfptr/plugins/showcase`, daemon started: `plugin list` shows no plugins, `plugin
threads showcase` lists both `[archived]`; `plugin uninstall showcase` answers "no plugin";
`plugin uninstall showcase --purge --yes` removes them ("removed its 2 threads: …").

`~/.cfptr`, `~/cfptr-showcase` and the test threads' transcripts were removed afterwards.

## Gotchas

* The first uninstall's Haiku turn had already finished by the time the CLI polled it
  busy and uninstalled; the dev takeover caught the helper mid-turn (`busy (working)` one
  command earlier). The unit test pins the mid-turn case deterministically.
* `removeThreads` runs the removals at once, so the fake's order is arbitrary; the result
  keeps creation order.
* `@typescript-eslint/restrict-template-expressions` refuses a number in a template
  literal: `String(n)`.
