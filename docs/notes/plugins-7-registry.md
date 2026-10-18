# Plugins 7: registries, install, update, uninstall (2026-10-18)

The seventh PR of the plugin stack (`docs/sketches/plugins/DECISIONS.md`, "Registry" and
build order row 7). Phase 1: the daemon and the CLI. Phase 2 (below, "GUI"): Settings →
Plugins → Browse on PR 5's page. Based on `cf/plugins-5-gui`; the orchestrator rebases it
onto PR 6.

## What is here

| Piece | Where |
|---|---|
| Registry client: index parse + validation, locations, cache + merge, gh / HTTPS fetch, release resolution, checksums, safe extraction | `internal/store/plugin/registry/` (fake gh in `registrytest`) |
| Install / uninstall / dev links, install records, progress events | `internal/store/plugin/install.go`, `install_db.go`, migration `0030_plugin_installs.sql` |
| Update offers, `CheckUpdates`, `Update`, `Browse`, `SetRegistries`, `RegistryChanged` | `internal/store/plugin/updates.go` |
| Setting `plugins.registries` | `internal/store/settings/schema.go` (Plugins › Registries), `Settings.Plugins.Registries` |
| Daemon glue: the client (gh path, cache dir), the setting, the update-check hook | `internal/daemon/plugin_registry.go` |
| `PluginService.Browse/RefreshRegistries/Install/Update/Uninstall`, `Plugin.install/update_*`, `PluginEvent.install_progress/registry_epoch` | `proto/codefoundry/v1/plugin.proto` (appended), `internal/api/plugin_registry.go` |
| `plugin browse`, `plugin install`, `plugin update`, `plugin uninstall` | `internal/command/commands_plugin_registry.go` |
| Release tarball tool | `pluginsdk/pack` + `pluginsdk/cmd/pluginpack` (stdlib only) |

## The flow

`plugin install <ref>`:

1. **Resolve.** `name[@version]`: the merged index (cached, 1 h; one forced re-read when
   the name is missing; `--refresh` always re-reads). `@version` other than the index's
   latest comes from the entry's `repo` releases (tag `v<version>`, checked against its
   checksums file). `owner/repo[@vX.Y.Z]`: `gh release view [tag] -R owner/repo --json
   tagName,assets`, the asset `<name>-<version>-darwin-<arch>.tar.gz` (name and version
   come from the asset name), the hash from `checksums.txt`, `SHA256SUMS`,
   `sha256sums.txt`, `<name>-<version>-checksums.txt` or `<asset>.sha256` when the
   release has one, else a warning ("not verified") and an empty recorded hash. A path
   (`/…` or `~/…`): a dev link (below).
2. **Download** into `~/.code-foundry/plugins/.staging/<name>-*/`: a
   `https://github.com/<o>/<r>/releases/download/<tag>/<asset>` URL with `gh release
   download <tag> -R <o>/<r> -p <asset> -O <file>` (private repositories work with the
   user's gh login, like the gh store), anything else with a GET (https; http only to
   loopback). 256 MiB cap.
3. **Verify** the SHA-256 (index entry or checksums file).
4. **Extract** (`registry.Extract`): only directories and regular files, no absolute
   names, no `..`, no links or devices, no duplicates; modes 0755 / 0644; at most 10,000
   entries and 512 MiB.
5. **Validate**: `pluginsdk.LoadManifest` (PR 1's validator), name and version equal the
   plan's, protocol 1, `exec[0]` resolves to an executable inside the package
   (`resolveExec`, the actor's own check), and for a registry install the manifest's
   permissions are **within the entry's** (Browse showed the entry's; the package may
   not ask for more).
6. **Swap** under `opMu`: `plugins/<name>` moves into the staging dir, the new package
   renames into place (the old one comes back if that fails), the staging dir is deleted.
   Two renames, not one atomic exchange: between them there is no package for a moment;
   discovery only runs under `opMu`, so nothing sees the gap. A dev link is refused
   without `--force` ("is a dev link to …"); with it, the link is removed and the
   `plugins.dev_path` cleared. The data dir (`plugin-data/<name>`) is never touched.
7. **Record** `plugin_installs(name, kind, source, version, sha256, installed_at)` and
   re-apply the plugin (`Manager.apply(…, restart=true)`): an enabled plugin restarts on
   the new package and stays enabled unless its permissions grew, which disables it with
   "its permissions changed: enable it again to review them" (PR 1's `needsConsent`). A new
   plugin has no `plugins` row, so it is **disabled pending consent**.
8. **Enable** only with `--enable` (the command's confirm, `--yes` on the CLI): consent
   to the permissions and start.

Every step publishes `plugin.InstallProgress` (resolving → downloading (with bytes for
HTTP) → verifying → extracting → installing → done | failed) on the plugin event source.

`plugin install <folder>` links like `plugin dev` (no copy, `dev_path`), records kind
`path`, and stays disabled unless `--enable --yes`; `plugin dev` stays as it was (link +
enable + follow the log). An installed package is not replaced by a link without
`--force`.

`plugin update [<name>] [--check] [--refresh]`: offers are computed from the merged index
for every non-dev plugin (semver, `update.Newer`); a plugin installed from a GitHub
release only matches an entry of the same repository. `--check` lists; otherwise each
offer is an `Install` of the registry name. Dev plugins are refused by name and never
offered. The result says when an enabled plugin came back disabled.

`plugin uninstall <name> [--purge]` (Confirm; `--yes`): disable (row `enabled=0`,
`dev_path` cleared), stop, unregister, drop env + flags (`forget`), remove the package
(a dev link: the link only, never the author's folder), delete the install record,
rescan. `--purge` also deletes every recorded secret (Keychain item + `plugin_secrets`
row), `plugin-data/<name>`, `logs/plugins/<name>.log*` and the `plugins` row (consent).
Without `--purge` the consent stays: reinstalling and `--enable` does not ask again
(while the permissions are within the grant).

## Where state lives

| What | Where |
|---|---|
| Packages | `~/.code-foundry/plugins/<name>/` (dir, or a symlink for dev) |
| Staging (downloads, unpacked packages, replaced packages until deleted) | `~/.code-foundry/plugins/.staging/` |
| Registry index cache (one file per registry: url, fetchedAt, the raw index) | `~/.code-foundry/plugins/.registries/<sha256(url)[:8]>.json` |
| Where a package came from | SQLite `plugin_installs` (migration 0030) |
| Enabled / consent / dev link | SQLite `plugins` (PR 1) |
| Plugin data | `~/.code-foundry/plugin-data/<name>/` (survives install, update and plain uninstall) |
| The registries | `settings.toml` `[plugins] registries` |

## Decisions

* **`plugins.registries` is a String setting** of comma-separated URLs (the settings
  schema has no list type and the GUI renders String as a text field). A TOML array in
  the file reads as the same comma list (`stringify` joins `[]any`). `"none"` is the empty
  list (an empty value is the default). Every entry is validated (`registry.ParseList`):
  `https://github.com/<owner>/<repo>` (or the `owner/repo` shorthand) is read with gh;
  any other https URL is the index itself (`/index.json` appended unless it ends in
  `.json`); plain http only to localhost/loopback (the index names the hashes, so it must
  not be open to tampering). It lives on a schema page `plugins` (section Registries),
  which the GUI draws with its own component (below), so it shows under Browse and
  settings search finds it.
* **Reading a GitHub registry**: `gh api -H "Accept: application/vnd.github.raw+json"
  repos/<owner>/<repo>/contents/index.json` (raw content, no base64; the default branch).
  gh's executable is `advanced.gh_path`, else PATH and Homebrew (`gh.LookPath`), with the
  gh store's non-interactive environment.
* **Cache**: 1 h TTL per registry, written atomically. A failed fetch keeps the stale
  cache in use and reports the error in that registry's status; a registry that never
  answered contributes nothing. `Cached()` reads the disk only: the store computes update
  offers at start without the network.
* **Merge** by name, first registry wins; a later registry's duplicate is an issue on
  that registry ("already listed by …, which comes first"). Index parsing is lenient:
  unknown fields ignored, an entry that fails validation (name, strict semver without
  `v`, repo shape, artifacts' platform / URL scheme / 64-hex sha256) is skipped with an
  issue, a newer `schema` is read with an issue; only a non-object or a missing
  `plugins` list fails a registry.
* **Update offers are derived, not stored**: the store keeps the last merged index and
  `publicLocked` computes `Plugin.Update` from it, so an offer is never stale against the
  installed version. Changing the index republishes every plugin whose offer changed
  (`plugin.Changed`, the existing event) and bumps `RegistryChanged{epoch}`
  (`PluginEvent.registry_epoch`, for the Browse page to re-read).
* **Update cadence**: the daemon subscribes to `update.Event`; each new `LastCheckedAt`
  (the app's update check, now hourly: `docs/notes/update-check-hourly.md`) runs
  `CheckUpdates(refresh=false)`, i.e. a fetch once the 1 h cache has expired. A build with
  updates disabled (dev builds) runs the same check on its own wall-clock loop
  (`CODE_FOUNDRY_UPDATE_DELAY`, then hourly). Never an install.
* **Ref syntax**: anything with a `/` that is not a path is `owner/repo`; a path must be
  absolute or `~/…` because `ref` is a String arg (the CLI only absolutizes Path args, and
  a Path arg would turn `hello` into `$PWD/hello`). A relative path is refused with a hint
  to use `plugin dev`, which is a Path arg.
* **`--enable` consent text**: for a registry name, the index entry's permissions (the
  package cannot ask for more, step 5); for a release or folder, a warning that the
  permissions are only known after download. `ConfirmIf` is simply `--enable`.
* **`browse` reserved** as a plugin name (`pluginsdk.ReservedNames`), with `install`,
  `uninstall`, `update` (already there); `host/invoke` refuses these verbs to plugins.
* **pluginpack** writes reproducible tarballs (sorted, epoch mtimes, no owners, PAX),
  refuses links, leaves out `.git` and `.DS_Store`, merges `checksums.txt`, and with
  `-repo -entry` writes the registry entry (`plugins/<name>.json`) with release URLs
  (`-url-base` for other hosting). Its output passes the registry's `scripts/validate.py`.

## GUI (phase 2)

| Piece | Where |
|---|---|
| View models: Browse, entries, registries, install progress, the install record and update offer on `PluginView`, `installOutcome` (plugin.install's result JSON) | `gui/frontend/src/api/plugin.ts` (the "Registries" part) |
| Browse, progress per plugin, busy state, install / update / uninstall actions; `install_progress` and `registry_epoch` are routed here from `stores/plugins.ts` `onPluginEvent` | `src/stores/pluginRegistry.ts` |
| Browse section (in PR 5's `SectionCard id="browse"` seam) | `components/plugin/settings/BrowseSection.tsx`, helpers in `registry.ts` |
| Update / Uninstall on Installed rows, "from <source>", "<v> is available." | `components/plugin/settings/PluginsPage.tsx` |
| Uninstall dialog with the purge checkbox | `components/plugin/settings/UninstallDialog.tsx` |
| The page's settings section (plugins.registries) | `PluginsPage` renders `pageSections(schema, page)`; `SettingsPage` lets a GUI page share a schema page's id |
| Mock: default registry with gh-actions and test-watcher 0.1.0 (descriptions from the registry's PRs #1/#2), test-watcher 0.0.9 installed and running, install steps 250 ms apart, `POST /__mock/plugin/registry?error=…` | `mock/pluginRegistry.ts`, hooks in `mock/plugins.ts`, `mock/server.ts`, `mock/settings.ts` |
| Tests | `src/api/pluginRegistry.test.ts`, `src/stores/pluginRegistry.test.ts`, `components/plugin/settings/registry.test.ts`, `e2e/plugin-registry.spec.ts`; `e2e/plugins.spec.ts` now counts four installed plugins |

What it does:

* **Browse** reads `PluginService.Browse` when the page opens (the daemon's 1 h cache) and
  again on Refresh (`refresh: true`) and whenever a `registry_epoch` arrives. A row: display
  name, version, a pill (none when not installed, "Installed" emerald, "Update from X"
  amber, "Dev X", "No build for this Mac"), description, the permissions in the consent
  dialog's words ("May …"), `repo · from <registry>`, and Install (amber outline) or
  "Update to X" (amber outline). Under the rows, each registry: its URL, "N plugins ·
  read 5 min ago", a failure in words (404 or no access through gh, gh not logged in or
  missing, offline; else the daemon's text) with "Showing what it listed last time." when
  the cache stands in. No entries: "No plugins listed yet." above the registry rows.
* **Install** runs `plugin.install <name>` through `runCommandForResult` (quiet; a failure
  is toasted and stays under the row in red). The row shows the daemon's
  `install_progress` steps inline ("Finding it…", "Downloading… 1.5 MB", "Checking the
  SHA-256…", "Unpacking…", "Installing…"). When the plugin comes back disabled it runs
  `plugin.enable`, so PR 5's consent dialog asks before anything runs.
* **Update** (Browse row or Installed row, amber outline when offered) runs
  `plugin.update <name>`.
* **Uninstall** (Installed rows, muted) opens a dialog with "Also delete its data, its
  secrets in the Keychain, its logs and the consent given" (= `--purge`); its Uninstall
  is destructive-outlined. The daemon's confirm for that call is answered by a presenter
  registered for `plugin.uninstall` (the user just confirmed), so it is not asked twice;
  from the palette the generic confirm shows the daemon's text.
* **Registries**: the `plugins.registries` field under Browse (a text field; the settings
  schema has no list type, so the description says "separate several with commas").

Screenshots (live isolated daemon, WebKit, dark and light, as PR 5): branch
`cf/plugins-7-shots`, `docs/notes/plugins-7-registry/*.png`: `browse-page-*` (the page
with gh-actions and test-watcher installed and hello listed by the loopback registry; the
real default registry empty), `install-progress-*` (downloading from a throttled
server), `install-consent-*`, `installed-after-install-*`, `installed-update-*` and
`browse-update-*` (hello 0.1.0 installed, 0.1.1 listed), `registries-setting-*`.

## The real plugins from their GitHub releases (2026-10-18, isolated `/tmp/cfp7`)

Both release `SHA256SUMS` (the skill's `make dist`), which `ResolveRelease` reads (with
`checksums.txt` and `sha256sums.txt`); the recorded hashes match the registry entries in
the registry's pull requests #1 and #2.

```
$ code-foundry plugin install alexwaumann/code-foundry-plugin-gh-actions
installed gh-actions 0.1.0 from alexwaumann/code-foundry-plugin-gh-actions
disabled until you enable it: code-foundry plugin enable gh-actions (lists its permissions)
$ code-foundry plugin install alexwaumann/code-foundry-plugin-test-watcher@v0.1.0 --enable --yes
installed test-watcher 0.1.0 from alexwaumann/code-foundry-plugin-test-watcher
enabled test-watcher 0.1.0 (starting)
commands: code-foundry plugin test-watcher run, code-foundry plugin test-watcher stop, code-foundry plugin test-watcher set-command, code-foundry plugin test-watcher toggle-watch
$ code-foundry plugin enable gh-actions --yes
enabled gh-actions 0.1.0 (starting)
commands: code-foundry plugin gh-actions rerun-failed, code-foundry plugin gh-actions rerun, code-foundry plugin gh-actions cancel, code-foundry plugin gh-actions open
$ code-foundry plugin list
NAME          VERSION  STATE    PERMISSIONS                                                                    COMMANDS  SURFACES    NOTE
gh-actions    0.1.0    running  commands(thread.send,view.open.url,pr.checks) events(gh,threads) threadStatus  4         runs(off)   
test-watcher  0.1.0    running  commands(thread.send) events(project,threads) threadStatus                     4         tests(off)  
$ code-foundry plugin logs gh-actions --lines 20
08:28:21.844 host       installed 0.1.0 from alexwaumann/code-foundry-plugin-gh-actions
08:28:23.578 host       enabled with consent to: run Code Foundry commands: pr.checks, thread.send, view.open.url; read events: gh, threads; raise threads to needs-attention or error
08:28:23.580 host       starting gh-actions 0.1.0 (pid 32442)
08:28:23.669 host       running
08:28:23.669 log info   gh-actions is up dev=false host=dev
08:28:23.669 host       subscribed sub-1 to threads, gh
log file: /tmp/cfp7/logs/plugins/gh-actions.log
$ code-foundry plugin logs test-watcher --lines 20
08:28:23.557 host       installed 0.1.0 from alexwaumann/code-foundry-plugin-test-watcher
08:28:23.558 host       enabled with consent to: run Code Foundry commands: thread.send; read events: project, threads; raise threads to needs-attention or error
08:28:23.560 host       starting test-watcher 0.1.0 (pid 32437)
08:28:23.663 host       running
08:28:23.663 host       subscribed sub-1 to threads, project
08:28:23.663 log info   test-watcher is up dev=false followed=0 host=dev
log file: /tmp/cfp7/logs/plugins/test-watcher.log
gh-actions|github|alexwaumann/code-foundry-plugin-gh-actions|0.1.0|7ad70901f01b7efe
test-watcher|github|alexwaumann/code-foundry-plugin-test-watcher|0.1.0|447deb231b78f729
```

gh-actions shows its surface only for a thread whose pull request has GitHub Actions
checks; `runs(off)` is that, the plugin is running and its log is clean.

## pluginpack (for plugin repositories' release workflows)

```
# one package directory per platform: plugin.json + the executable its exec names
GOOS=darwin GOARCH=arm64 go build -o build/arm64/bin/x . && cp plugin.json build/arm64/
GOOS=darwin GOARCH=amd64 go build -o build/amd64/bin/x . && cp plugin.json build/amd64/
go run github.com/alexwaumann/code-foundry/pluginsdk/cmd/pluginpack@<commit> \
    -out dist -repo owner/code-foundry-plugin-x -entry dist/x.json \
    darwin/arm64=build/arm64 darwin/amd64=build/amd64
# dist/x-<v>-darwin-{arm64,amd64}.tar.gz and dist/checksums.txt go on the release v<v>;
# dist/x.json is plugins/x.json for the registry pull request.
```

It prints `<sha256>  <file>` per tarball. A bare `DIR` is `darwin/<this arch>`;
`-url-base` replaces the GitHub release URLs (other hosting, local tests).

## Gotchas

* `resolveExec` compares resolved paths: the staging dir must be `EvalSymlinks`ed first
  (`/var` → `/private/var` in tests; a symlinked `CODE_FOUNDRY_HOME` too).
* `PhaseFailed` already exists (surfaces); the install phases are `Install*`.
* Installing a registry name within the cache's hour does not see a just-published
  version: `--refresh` (or `plugin browse --refresh` first).
* `make gen` regenerates `gui/frontend/src/gen/.../plugin_pb.ts` too (committed generated
  code; no GUI source changed in this phase).
* Migration 0030 may need renumbering when rebasing onto PR 6 if it adds one (PRs 4 and 5
  added none).

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=/tmp/cfp7`, dev build)

Setup: `plugins/examples/hello` built into two release-shaped packages (`pkg/0.1.0`,
`pkg/0.1.1`: `plugin.json` + `bin/hello`, the 0.1.1 manifest only bumped), packed with
pluginpack, an `index.json` written around the entry it printed, and the directory
served with `python3 -m http.server 8765 --bind 127.0.0.1`. The 0.1.0 tarball also
passed the registry repository's own `scripts/validate.py` (`ok hello 0.1.0`).

```
$ cd pluginsdk && go build -o /tmp/cfp7e2e/pluginpack ./cmd/pluginpack
$ cd /tmp/cfp7e2e && ./pluginpack -out srv -repo alexwaumann/code-foundry-plugin-hello -entry hello-0.1.0.json \
    -url-base http://127.0.0.1:8765 darwin/arm64=pkg/0.1.0
57e14ed0787d884c23ab8d1af26433b246024266e276b15054ea9edc13529eee  srv/hello-0.1.0-darwin-arm64.tar.gz
registry entry: hello-0.1.0.json
$ tar tzvf srv/hello-0.1.0-darwin-arm64.tar.gz
drwxr-xr-x  0 0      0           0 Dec 31  1969 bin/
-rwxr-xr-x  0 0      0     4051346 Dec 31  1969 bin/hello
-rw-r--r--  0 0      0        3284 Dec 31  1969 plugin.json
$ python3 -I validate/repo/scripts/validate.py validate/repo/plugins/hello.json
ok hello 0.1.0
$ CODE_FOUNDRY_HOME=/tmp/cfp7 CODE_FOUNDRY_UPDATE_DELAY=1h ./bin/code-foundry daemon --dev &
```

The session (`code-foundry` with `CODE_FOUNDRY_HOME=/tmp/cfp7`; between parts the index
was rewritten and the daemon restarted as the comments say). `plugin hello remember`
wrote to the real login Keychain; the purge removed it (`security find-generic-password
-s code-foundry-plugin -a hello/word` finds nothing afterwards). The default registry
(`alexwaumann/code-foundry-plugins`, empty) is read through gh and cached.

```
$ code-foundry daemon status
daemon pid 76988, version dev, up 4s, home /tmp/cfp7
$ code-foundry settings set plugins.registries http://127.0.0.1:8765/index.json
plugins.registries = "http://127.0.0.1:8765/index.json"
$ code-foundry plugin browse
NAME   VERSION  INSTALLED  PERMISSIONS                                                                      DESCRIPTION
hello  0.1.0    -          commands(pr.checks,thread.send) events(threads) threadStatus sessionEnv secrets  The example plugin: greets, sends a message to a thread t...
registry http://127.0.0.1:8765/index.json: 1 plugin(s), fetched 2026-10-18 06:59
$ code-foundry plugin install hello
installed hello 0.1.0 from http://127.0.0.1:8765/index.json
disabled until you enable it: code-foundry plugin enable hello (lists its permissions)
$ code-foundry plugin list
NAME   VERSION  STATE     PERMISSIONS                                                                      COMMANDS  SURFACES                           NOTE
hello  0.1.0    disabled  commands(thread.send,pr.checks) events(threads) threadStatus sessionEnv secrets  8         demo(off) pinned(off) checks(off)  new: code-foundry plugin enable hello
$ code-foundry plugin enable hello
code-foundry plugin.enable: Enable Hello 0.1.0? It runs bin/hello as you and may:
  - run Code Foundry commands: pr.checks, thread.send
  - read events: threads
  - raise threads to needs-attention or error
  - add environment variables, PATH entries and directories to new Claude sessions
  - keep secrets in your Keychain (its own, under code-foundry-plugin)
Re-run with --yes to confirm.
$ code-foundry plugin enable hello --yes
enabled hello 0.1.0 (starting)
commands: code-foundry plugin hello greet, code-foundry plugin hello send, code-foundry plugin hello remember, code-foundry plugin hello recall, code-foundry plugin hello forget, code-foundry plugin hello unpin, code-foundry plugin hello flag, code-foundry plugin hello events
$ code-foundry plugin hello greet Ada
Hello, Ada!
$ code-foundry plugin hello remember swordfish
remembered (in the Keychain)
$ pluginpack -out srv -repo alexwaumann/code-foundry-plugin-hello -entry hello-0.1.1.json -url-base http://127.0.0.1:8765 darwin/arm64=pkg/0.1.1
9c83c08be936a1b1d75c90e7d2b70cbf75ee2819ad85014cdb9194c0e58b1732  srv/hello-0.1.1-darwin-arm64.tar.gz
registry entry: hello-0.1.1.json
$ code-foundry plugin update --check
every plugin is up to date
$ code-foundry plugin update --check --refresh
NAME   INSTALLED  AVAILABLE  REGISTRY
hello  0.1.0      0.1.1      http://127.0.0.1:8765/index.json
install with: code-foundry plugin update [<name>]
$ code-foundry plugin list
NAME   VERSION  STATE    PERMISSIONS                                                                      COMMANDS  SURFACES                           NOTE
hello  0.1.0    running  commands(thread.send,pr.checks) events(threads) threadStatus sessionEnv secrets  8         demo(off) pinned(off) checks(off)  
$ code-foundry plugin update hello
updated hello 0.1.0 → 0.1.1
$ code-foundry plugin list
NAME   VERSION  STATE    PERMISSIONS                                                                      COMMANDS  SURFACES                           NOTE
hello  0.1.1    running  commands(thread.send,pr.checks) events(threads) threadStatus sessionEnv secrets  8         demo(off) pinned(off) checks(off)  
$ code-foundry plugin hello recall
the word is swordfish
$ code-foundry plugin secrets list hello
KEY   SET
word  2026-10-18 06:59
$ code-foundry plugin uninstall hello --purge
code-foundry plugin.uninstall: Uninstall plugin hello and delete its data, its secrets in the Keychain, its logs and the consent given?
Re-run with --yes to confirm.
$ code-foundry plugin uninstall hello --purge --yes
uninstalled hello (removed /tmp/cfp7/plugins/hello)
deleted 1 secret(s) from the Keychain, its data in /tmp/cfp7/plugin-data/hello, its logs, its consent and settings
$ code-foundry plugin list
no plugins (put one in ~/.code-foundry/plugins/<name>, or: code-foundry plugin dev <folder>)
/tmp/cfp7/plugins:
drwx------@ - alex 18 Oct 06:59 .registries
drwx------@ - alex 18 Oct 06:59 .staging

/tmp/cfp7/plugin-data:
keychain item gone
0
0
0
$ code-foundry plugin install hello --enable
code-foundry plugin.install: Install and enable Hello 0.1.1 from http://127.0.0.1:8765/index.json? It runs as you and may:
  - run Code Foundry commands: pr.checks, thread.send
  - read events: threads
  - raise threads to needs-attention or error
  - add environment variables, PATH entries and directories to new Claude sessions
  - keep secrets in your Keychain (its own, under code-foundry-plugin)
Re-run with --yes to confirm.
$ code-foundry plugin install hello --enable --yes
installed hello 0.1.1 from http://127.0.0.1:8765/index.json
enabled hello 0.1.1 (starting)
commands: code-foundry plugin hello greet, code-foundry plugin hello send, code-foundry plugin hello remember, code-foundry plugin hello recall, code-foundry plugin hello forget, code-foundry plugin hello unpin, code-foundry plugin hello flag, code-foundry plugin hello events
$ code-foundry plugin uninstall hello --yes
uninstalled hello (removed /tmp/cfp7/plugins/hello)
$ code-foundry settings reset plugins.registries
plugins.registries = "https://github.com/alexwaumann/code-foundry-plugins" (default)
$ code-foundry settings get plugins.registries
https://github.com/alexwaumann/code-foundry-plugins
$ code-foundry plugin browse
no plugins in the registries
registry https://github.com/alexwaumann/code-foundry-plugins: 0 plugin(s), fetched 2026-10-18 07:00
$ code-foundry plugin browse --json
{"registries":[{"url":"https://github.com/alexwaumann/code-foundry-plugins","fetchedAt":"2026-10-18T12:00:00.085832Z","cached":true}],"platform":"darwin/arm64"}
.rw-------@ 762 alex 18 Oct 06:59 5bada74edd2eb09b.json
.rw-------@ 174 alex 18 Oct 07:00 9498aa24c9b9170e.json
/tmp/cfp7/plugins/.registries/5bada74edd2eb09b.json:
{"url":"http://127.0.0.1:8765/index.json","fetchedAt":"2026-10-18T11:59:46.142354Z","index":{"schema":1,"generatedAt":"2026-10-18T13:00:00Z","plugins":[{"name":"hello","displayName":"Hello","description":"The example plugin: greets, sends a message to a thread through the host, keeps a word in the Keychain, follows the thread list, flags threads and gives new threads CF_HELLO=1.","repo":"alexwaumann/code-foundry-plugin-hello","version":"0.1.1","protocol":1,"permissions":{"commands":["pr.checks","thread.send"],"events":["threads"],"threadStatus":true,"sessionEnv":true,"secrets":true},"artifacts":{"darwin/arm64":{"url":"http://127.0.0.1:8765/hello-0.1.1-darwin-arm64.tar.gz","sha256":"9c83c08be936a1b1d75c90e7d2b70cbf75ee2819ad85014cdb9194c0e58b1732"}}}]}}
/tmp/cfp7/plugins/.registries/9498aa24c9b9170e.json:
{"url":"https://github.com/alexwaumann/code-foundry-plugins","fetchedAt":"2026-10-18T12:00:00.085832Z","index":{"schema":1,"generatedAt":"2026-10-18T09:46:42Z","plugins":[]}}
$ code-foundry plugin browse
no plugins in the registries
registry https://github.com/alexwaumann/code-foundry-plugins: 0 plugin(s), fetched 2026-10-18 07:00 (cached)
$ code-foundry plugin install hello
code-foundry plugin.install: not found: no plugin "hello" in the registries (https://github.com/alexwaumann/code-foundry-plugins)
Run `code-foundry help plugin.install` for usage.
$ code-foundry plugin install alexwaumann/code-foundry-plugins
code-foundry plugin.install: not found: not found: alexwaumann/code-foundry-plugins has no a release (or no access with your gh login)
Run `code-foundry help plugin.install` for usage.
$ code-foundry plugin install ./plugins/examples/hello
code-foundry plugin.install: invalid argument: "./plugins/examples/hello" is a relative path: give an absolute one, or run `code-foundry plugin dev ./plugins/examples/hello`, which resolves it
Run `code-foundry help plugin.install` for usage.
### after the fixes (daemon rebuilt)
$ code-foundry plugin install alexwaumann/code-foundry-plugins
code-foundry plugin.install: not found: alexwaumann/code-foundry-plugins has no published release (or no access with your gh login)
Run `code-foundry help plugin.install` for usage.
$ code-foundry plugin install $REPO/plugins/examples/hello
linked $REPO/plugins/examples/hello as dev plugin hello 0.1.0
disabled until you enable it: code-foundry plugin enable hello (lists its permissions)
$ code-foundry plugin list
NAME   VERSION  STATE           PERMISSIONS                                                                      COMMANDS  SURFACES                           NOTE
hello  0.1.0    disabled (dev)  commands(thread.send,pr.checks) events(threads) threadStatus sessionEnv secrets  8         demo(off) pinned(off) checks(off)  
$ code-foundry plugin install hello --force
code-foundry plugin.install: not found: no plugin "hello" in the registries (https://github.com/alexwaumann/code-foundry-plugins)
Run `code-foundry help plugin.install` for usage.
$ code-foundry plugin uninstall hello --yes
uninstalled hello (removed /tmp/cfp7/plugins/hello)
$ code-foundry settings set plugins.registries http://127.0.0.1:8765/index.json, https://github.com/alexwaumann/code-foundry-plugins
plugins.registries = "http://127.0.0.1:8765/index.json, https://github.com/alexwaumann/code-foundry-plugins"
$ code-foundry plugin install hello --refresh
installed hello 0.1.0 from http://127.0.0.1:8765/index.json
disabled until you enable it: code-foundry plugin enable hello (lists its permissions)
# index bumped to 0.1.1, caches dropped, daemon restarted with CODE_FOUNDRY_UPDATE_DELAY=5s
$ code-foundry plugin list
NAME   VERSION  STATE     PERMISSIONS                                                                      COMMANDS  SURFACES                           NOTE
hello  0.1.0    disabled  commands(thread.send,pr.checks) events(threads) threadStatus sessionEnv secrets  8         demo(off) pinned(off) checks(off)  
time=2026-10-18T07:01:00.469-05:00 level=INFO msg="plugin update check" component=plugins updates=1
$ code-foundry plugin list
NAME   VERSION  STATE     PERMISSIONS                                                                      COMMANDS  SURFACES                           NOTE
hello  0.1.0    disabled  commands(thread.send,pr.checks) events(threads) threadStatus sessionEnv secrets  8         demo(off) pinned(off) checks(off)  0.1.1 available: code-foundry plugin update hello
$ code-foundry plugin browse
NAME   VERSION  INSTALLED       PERMISSIONS                                                                      DESCRIPTION
hello  0.1.1    0.1.0 (update)  commands(pr.checks,thread.send) events(threads) threadStatus sessionEnv secrets  The example plugin: greets, sends a message to a thread t...
registry http://127.0.0.1:8765/index.json: 1 plugin(s), fetched 2026-10-18 07:01 (cached)
registry https://github.com/alexwaumann/code-foundry-plugins: 0 plugin(s), fetched 2026-10-18 07:01 (cached)
$ code-foundry plugin update
updated hello 0.1.0 → 0.1.1
$ code-foundry plugin uninstall hello --purge --yes
uninstalled hello (removed /tmp/cfp7/plugins/hello)
deleted its data in /tmp/cfp7/plugin-data/hello, its logs, its consent and settings
```

The plugin event source during `plugin update hello` (`code-foundry events --source plugin`):
`registry-epoch`, then `install-progress` × 6 (resolving, downloading, verifying,
extracting, installing, done) interleaved with `updated hello` as it stopped and restarted.

## Open

* Browse has no search or filter (registries are small today), and no per-entry "show
  the manifest" before install; the permissions come from the entry.
* An install failure stays under its row until the next try or a reload of the page.
* Direct (GitHub release) installs not listed in any registry get no update offers; only
  the merged index is compared. `plugin install owner/repo` again installs the latest.
* No signing (DECISIONS: trust = registry owner + hash + consent).
* The download size cap (256 MiB) and the gh download have no byte progress.
