# Plugins: Browse offers updates only from the install source (2026-10-18)

Follow-up from `docs/notes/plugins-release-readiness.md` ("Nice to have after"): Browse
showed "Update from 0.1.1" for another registry's entry of an installed name, which
`plugin install` / the Update button then refused as a takeover (plugins 8's install
identity) and `plugin update` ignored. On `origin/main` 4ed617fd.

## What changed

| Piece | Where |
|---|---|
| `plugin.Relation` (not_installed, installed, update, dev, other_source), `sameSource`, `relate`, `SourceLabel`, `ShortURL`; `offerFor` rewritten on top of them; `BrowseEntry.Relation/InstalledFrom`; `PluginUpdate.InstalledFrom` (a newer version another source lists, not an offer) | `internal/store/plugin/updates.go` |
| `PluginIndexRelation` enum, `PluginIndexEntry.relation` / `installed_from`, `PluginUpdate.installed_from` | `proto/codefoundry/v1/plugin.proto` |
| Browse maps the store's relation; `update_available` is now `relation == UPDATE` (was a bare version comparison in the handler) | `internal/api/plugin_registry.go` |
| `plugin browse`: INSTALLED says `0.1.0 (installed from 127.0.0.1:8771/index.json)`; `plugin update [--check]`: offers as before, then `not offered: …` lines | `internal/command/commands_plugin_registry.go` |
| `IndexEntryView.relation` / `installedFrom` (replace `installedDev` / `updateAvailable`); `entryPill` and `entryAction` switch on it; Browse renders Install only for not-installed, Update only for update, a muted "Installed from <source>" pill for other-source, and no empty action row | `gui/frontend/src/api/plugin.ts`, `components/plugin/settings/{registry.ts,BrowseSection.tsx}` |
| Mock: a second registry `LOOPBACK_REGISTRY` (`http://127.0.0.1:8765/index.json`, not configured by default) listing acme-data 1.3.0 and a test-watcher 0.2.0; registries merged first-wins with the daemon's duplicate issue; relation and offers computed like the daemon; acme-data now installed from `https://plugins.acme.dev/index.json`; plugins republished when the registries change | `gui/frontend/mock/{pluginRegistry,plugins}.ts` |
| Tests | `updates_internal_test.go` `TestRelationAndOffer` (table), `origin_test.go` `TestNoUpdateFromAnotherRegistry` (now also Browse + the check's note), `TestUpdateFromARegistryEntryOfTheReleaseRepo`, `install_test.go`, `internal/api/plugin_registry_test.go`, `internal/command/commands_plugin_registry_test.go`, `src/api/pluginRegistry.test.ts`, `settings/registry.test.ts`, `settings/BrowseSection.test.tsx`, `e2e/plugin-registry.spec.ts` ("with a second registry …") |

## Decisions

* **One decision, in the store.** `relate(installed, entry)` is what Browse shows and
  `offerFor` (the Installed row's `Plugin.update_*`) offers; the API and the GUI only map
  it. The handler no longer compares versions itself.
* **Same source** = the registry URL the plugin was installed from; for a plugin
  installed from `owner/repo`, a registry entry whose `repo` is that repository (case
  insensitive), from whichever registry. A registry install is bound to its registry, not
  to the repository its entry named. A package put in `plugins/` by hand has no source an
  entry can match: other source, "the plugins folder". (It used to get the merged
  entry's offer, which the takeover check refused once it had consent.)
* **A release install's update from a registry entry of its repository installs that
  repository's release** (`UpdateOffer.Ref = owner/repo@vX.Y.Z`). Installing the registry
  name instead would record origin `registry:<url>` against the plugin's
  `github:owner/repo`, which `checkOrigin` refuses as a takeover; PR 7 offered it, PR 8
  made it fail. `TestUpdateFromARegistryEntryOfTheReleaseRepo` covers it (consent, secret
  and data kept, still a release install).
* **Other source: no button at all**, not a disabled one, and a muted pill. Switching is
  `plugin install <name> --force` (deletes secrets, data, consent), which the CLI's
  "not offered" line names; the GUI does not offer it (a destructive takeover from a
  Browse row would need its own confirm; not asked for).
* **`plugin update --check` lists another source's newer version** after the offers, as
  `not offered: <name> <v> from <registry> (installed from <source>; …--force…)`, unless
  the plugin's own source offers as much. `plugin update` skips those rows (never
  installs them) and prints the same line. Proto: `PluginUpdate.installed_from` set means
  "not an offer".
* **The source label is the daemon's** (`SourceLabel`): a registry URL without scheme and
  `github.com/` (the GUI's `shortSource` rule, `/index.json` kept, so it matches the row's
  `from <registry>` line), `owner/repo`, or "the plugins folder".

## Limit (unchanged, noted)

The merged index keeps the first registry's entry per name and drops later ones (with an
issue). A plugin installed from registry B while registry A, listed first, has the same
name sees A's entry as "Installed from B" and gets **no** update offer from B, since B's
entry is not in the merged index. The e2e test asserts this (loopback registry first).
Keeping shadowed entries per registry would fix it; not done here.

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=~/.cf-browse-offer`, dev build)

Two loopback registries served with `python3 -m http.server` (`:8771` A, `:8772` B),
packages of `plugins/examples/{hello,minimal}` packed with `pluginpack -url-base`.

```
$ code-foundry settings set plugins.registries http://127.0.0.1:8771/index.json
$ code-foundry plugin install hello --enable --yes
installed hello 0.1.0 from http://127.0.0.1:8771/index.json
$ code-foundry plugin install minimal --enable --yes
installed minimal 0.1.0 from http://127.0.0.1:8771/index.json
# A lists hello 0.1.1; B lists minimal 0.2.0 (repo someone-else/…); B first
$ code-foundry settings set plugins.registries http://127.0.0.1:8772/index.json,http://127.0.0.1:8771/index.json
$ code-foundry plugin browse --refresh
NAME     VERSION  INSTALLED                                         PERMISSIONS  DESCRIPTION
hello    0.1.1    0.1.0 (update)                                    commands(…)  The example plugin: …
minimal  0.2.0    0.1.0 (installed from 127.0.0.1:8771/index.json)  -            The smallest complete …
registry http://127.0.0.1:8772/index.json: 1 plugin(s), fetched 2026-10-18 19:44
registry http://127.0.0.1:8771/index.json: 2 plugin(s), fetched 2026-10-18 19:44
  issue: minimal: already listed by http://127.0.0.1:8772/index.json, which comes first
$ code-foundry plugin update --check
NAME   INSTALLED  AVAILABLE  REGISTRY
hello  0.1.0      0.1.1      http://127.0.0.1:8771/index.json
install with: code-foundry plugin update [<name>]
not offered: minimal 0.2.0 from http://127.0.0.1:8772/index.json (installed from 127.0.0.1:8771/index.json; `code-foundry plugin install minimal --force` switches to it, deleting its secrets, data and consent)
$ code-foundry plugin install minimal
code-foundry plugin.install: failed precondition: plugin minimal came from the registry http://127.0.0.1:8771/index.json, and a package from the registry http://127.0.0.1:8772/index.json would inherit the consent you gave it; --force deletes them …
$ code-foundry plugin update
updated hello 0.1.0 → 0.1.1
not offered: minimal 0.2.0 from http://127.0.0.1:8772/index.json (installed from 127.0.0.1:8771/index.json; …)
```

Then A listed hello 0.1.2 and Settings → Plugins (vite dev server against that daemon,
WebKit) showed Hello "Update from 0.1.1" with "Update to 0.1.2", Minimal "Installed from
127.0.0.1:8771/index.json" with no button, and the Installed rows offering 0.1.2 for
Hello only. Screenshots (dark and light): branch `cf/plugins-browse-offer-shots`,
`docs/notes/plugins-browse-offer/*.png`.

## Gotchas

* The mock computed `Plugin.update_*` when a message was built but never republished
  when the registries changed (the daemon's `setMerged` does), so an Installed row kept a
  stale offer after `plugins.registries` changed; `RegistryDeps.republish` fixes that.
* `ghRelease` (origin_test.go) now also serves the release by its tag, which an update
  to `owner/repo@vX.Y.Z` asks for.
