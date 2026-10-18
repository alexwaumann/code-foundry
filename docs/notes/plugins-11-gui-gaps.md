# Plugins 11: the GUI gaps (2026-10-18)

The GUI items picked for release from the integration note's "Known gaps"
(`docs/notes/plugins-integration.md`), on `cf/plugins-7-registry` (73685d8b). Frontend
plus one small proto addition. Siblings off the same commit: plugins 8 (secrets), 9
(fuzz), 10 (host gaps: daemon, CLI, SDK); the stack is restacked by the orchestrator.

## What is here

| Item | Where |
|---|---|
| Flag click-through: a click (or Enter) on a sidebar row whose line 2 shows a plugin's flag opens the thread and, when that plugin has a thread- or pr-scoped surface available for it, that surface's tab | `src/stores/flagSurface.ts` (`shownFlag`, `flagSurfaces`, `flagSurfaceFor`, `openFlagSurface`), called from `components/sidebar/Sidebar.tsx` `activate` |
| Flag chip in the thread header: plugin display name + reason, amber or red text (no fill), a click opens the same surface, × clears the flag | `components/thread/FlagChip.tsx`, mounted after `ThreadTitle` in `ThreadPane.tsx`; `clearThreadFlag` in `stores/flagSurface.ts` |
| Secrets in Settings → Plugins: a "Secrets ›" toggle on rows of plugins that ask for (or were granted) secrets; names and "set 3 d ago", never values; delete with the daemon's confirm | `components/plugin/settings/SecretsSection.tsx`, `stores/pluginSecrets.ts`, `listPluginSecrets` / `toSecretView` in `api/plugin.ts`, `keepsSecrets` in `settings/state.ts` |
| Install failure: the daemon's error text under the Browse row, a dismiss ×, cleared by the next attempt | `failedProgress`, `dismissInstallFailure` in `stores/pluginRegistry.ts`; `Progress` in `BrowseSection.tsx` |
| Real plugin folders: Settings → Plugins ("Plugins in ~/.cf-p11/plugins.") and the uninstall dialog ("its package goes from …", "Its data (…/plugin-data/<name>) …") | proto `ListPluginsResponse.plugins_dir` / `data_dir`, `api.Plugin.WithDirs` (daemon passes `paths.Plugins()` / `paths.PluginData()`); `pluginDirs` in `api/plugin.ts`, `dirs` + `loadPluginDirs` in `stores/plugins.ts`, words in `settings/dirs.ts` |
| Browse empty states: "No registry configured. Add one in Registries" (the link focuses `plugins.registries`) when no registry is configured; "No plugins listed yet." only when a registry answered with none | `emptyBrowse` / `REGISTRIES_SETTING` in `settings/registry.ts`, `BrowseSection.tsx`; `components/settings/focus.ts` (`focusSetting`) |
| Mock | `mock/plugins.ts` (secrets, `dirs`, `plugin.secrets.delete`), `mock/pluginRegistry.ts` (registries from the setting, `installError`), `mock/world.ts` (`thread.flag.clear`, `clearFlags`), controls `POST /__mock/plugin/registry?installError=…`, `POST /__mock/plugin/dirs?home=…` |
| Tests | `stores/flagSurface.test.ts`, `components/thread/FlagChip.test.tsx`, `stores/pluginSecrets.test.ts`, `stores/pluginRegistry.test.ts`, `settings/{registry,dirs}.test.ts`, `api/plugin.test.ts`, `internal/api/plugin_test.go` `TestPluginListDirs`, `e2e/plugin-gaps.spec.ts` |

## Decisions

* **Which surface a flag opens**: the flag's plugin's surfaces with scope `thread` or `pr`,
  in manifest order, the first whose show command is available for the thread. Availability
  is the commands store's, listed for the thread's context (`showState`); right after the
  click the list is still the old selection's, so `openFlagSurface` waits for it (3 s at
  most, and not when the selection moves on). It opens through `showView("panel.<kind>?thread=<id>")`,
  the ShowView path a show command takes. The flag is read before selecting: opening the
  thread clears until-seen flags.
* **Only the flag line 2 shows** triggers the click-through (`shownFlag` = `statusLine`'s
  `flagAttention` / `flagError`): when Claude's prompt or error wins line 2, the click
  opens just the thread. Enter on the row does the same as a click (one `activate`).
* **The header chip shows the top flag** (`topFlag`, errors first), one chip; clearing it
  shows the next. Its × runs `thread.flag.clear --plugin` (the command over
  `ThreadService.ClearFlags`), not the RPC directly: every user action is a command.
* **Secret delete is `plugin.secrets.delete`**, whose `Confirm` is the daemon's generic
  confirm ("Delete secret token of plugin acme-data from the Keychain?"); the list
  (`PluginService.ListSecrets`) is read when the toggle opens it and again after a delete.
  No dependency on a secret-changed event.
* **Install failure text**: the daemon's failed `install_progress` message when it sent
  one, else the command's error (`onError`), else (a declined confirm) the row clears.
* **Directories via `PluginService.List`** (read once when Settings → Plugins opens), not on
  every `Plugin` message: the folder is the daemon's, not the plugin's, and the page needs
  it with no plugins installed. Until it answers (or from a daemon that does not say) the
  words are "the plugins folder". Paths show with `~` for the home (`tildify`).
* **Empty registry**: implemented against both defaults. The mock now derives Browse's
  registries from `plugins.registries` ("" or "none" lists none; the default registry lists
  the two plugins; any other URL answers empty) and bumps the registry epoch when it
  changes, so either default renders the right state.
* **Rebased onto the empty default (2026-10-18).** PR 7 now defaults `plugins.registries`
  to empty and built the same mock plumbing (`MockRegistry.settingsChanged`, `listed`, a
  `registries` dep, the fixture registry set explicitly in the mock's settings, and
  `MockSettings.value` so the registry never reads the keybinding fields). The rebase kept
  PR 7's mock and added this PR's `installError`; Browse's empty state is this PR's (the
  link), so `e2e/plugin-registry.spec.ts`'s no-registry test expects its words.

## Skipped (noted, not built)

* **Env "keep their old environment" hint, conditional**: not easy from existing stores.
  `ThreadView` has no process start time (only `createdAtMs`, `lastActivityAtMs`,
  `statusChangedAtMs`); comparing `PluginEnvironment.updated_at` with "the newest running
  thread's start" needs a `Thread.started_at` (daemon). The static line stays: "New threads
  get this; running threads keep what they spawned with."
* Bottom-panel plugin terminals forgotten on reload (PR 6) and usage grouping by plugin.

## Gotchas

* `react-refresh/only-export-components`: helpers live in `.ts` files (`settings/registry.ts`,
  `settings/state.ts`, `stores/flagSurface.ts`), not next to the components.
* A `useSyncExternalStore` snapshot must be stable: `useFlagSurfaceKind` returns the kind
  string, not the manifest (`allSurfaces` builds new objects).
* `e2e/plugin-registry.spec.ts`'s uninstall test now expects the data folder in the
  dialog's words. `make gui-e2e` (36 min under load from sibling agents): 941 passed; the
  only other failure, `workspaces.spec.ts` "pick a project, add Also in" on Chromium
  (composer heading not found in 5 s), passed on WebKit and on a rerun: load, not this change.
* The mock's `MockSettings.values()` lists command keybinding fields, which reads the
  plugins: `MockRegistry` must not read the setting while `MockPlugins` is being built.

## End to end (2026-10-18)

Live, isolated `CODE_FOUNDRY_HOME=~/.cf-p11`, dev build of this branch:

```
make build plugins
env -u CLAUDE… CODE_FOUNDRY_HOME=~/.cf-p11 ./bin/code-foundry daemon --dev &
code-foundry plugin dev $PWD/plugins/examples/hello --yes
code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --name "Ship the release notes" --created-by=   # and two more
code-foundry plugin hello flag --context-thread s-41b9ad81dbf4 --level attention --reason "deploy needs approval"
code-foundry plugin hello flag --context-thread s-892d5f884d26 --level error --reason "3 tests failed in ./internal/store"
cd gui/frontend && pnpm exec vite --port 9583 --strictPort --host 127.0.0.1   # opened with ?daemon=…&token=…
```

Clicking "Ship the release notes" opened the thread with Hello Demo in its panel; the
header showed the amber chip, the red one on the other thread; Settings → Plugins said
"Plugins in ~/.cf-p11/plugins."; the uninstall dialog "its link goes from
~/.cf-p11/plugins"; `code-foundry settings set plugins.registries none` turned Browse to
"No registry configured." and the link focused the field. Secrets and the install
failure were shot on the mock daemon (`MOCK_PORT=7913`): hello's live secret would sit in
the login Keychain (shared with the real home), and a real install failure needs a broken
release. Screenshots (dark and light, WebKit): branch `cf/plugins-11-shots`,
`docs/notes/plugins-11-gui-gaps/*.png`.
