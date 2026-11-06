# Settings → Plugins redesign (2026-11-05)

The second of two PRs: Settings → Plugins on the catalog layout `skills-page-redesign.md`
describes, so the shared pieces are not repeated here. GUI only: no Go, proto or migration
change.

## What is here

| Piece | Where |
|---|---|
| The page: modes, notices, Update all | `components/plugin/settings/PluginsPage.tsx` |
| Installed and registry rows, details, env summary, install progress | `components/plugin/settings/PluginRows.tsx` |
| Groups, row pill and main action, menu, search (pure) | `components/plugin/settings/model.ts` |
| Registries as a dialog with the page's settings | `components/plugin/settings/RegistriesDialog.tsx` |
| Busy and failures for enable, disable, restart, reload, update, uninstall | `stores/pluginRegistry.ts` (`act`, `runPluginAction`) |
| Update all's button, shared with Skills | `components/settings/catalog/UpdateAll.tsx` |

`readWords` moved to the catalog model, for both pages' "Read 5 min ago".

## Decisions

* **Groups.** Needs you takes an update (not a dev link's), Crashed, Failed, consent lost (the
  old "Needs consent" pill: disabled with a reason). A new plugin that was never enabled is
  simply Disabled: nothing went wrong. Running takes every enabled plugin, starting or not; the
  row's pill says Starting or Stopping.
* **Pills.** A row shows `statePill` only when the group and switch do not already say it: not
  for Running or plain Disabled.
* **Busy.** Enable, Disable, Restart and Reload had no busy state. They now go through one `act`,
  which holds the row busy and keeps a failure under it (as `stores/skill.ts` does), for update and
  uninstall too. Restart, Reload and Uninstall come from the menu, so the row says "Restarting…"
  where its action sits. A row busy with anything disables its switch: a second command would be
  dropped.
* **Switch and consent.** `plugin.enable` keeps its confirm, so a first enable still shows the
  consent dialog; the switch reads on and busy behind it and goes back if declined. No restart
  warning on disable here: `RESTART_WARNING` is about what Claude Code loads ("Threads that are
  running keep it"), which is untrue of a plugin, whose process stops and whose panels go at
  once. `plugin.disable` has its own success toast, and a thread that kept the plugin's
  environment says so in its header.
* **Secrets** toggles a list in the row's details and opens the row. Logs is the same dialog.
* **Reload** is `plugin.reload`, which rescans the whole plugins folder and takes no name. It is
  on dev plugins' menus, as designed, and shows on the row it was picked from.
* **Search** is in the client. An entry's repository can find an installed row, as Skills' keywords
  do. Every entry shown as an installed row above leaves no registries group at all, rather than
  "Nothing in your registries matches", which would be false; the Skills page gets the same fix.
* **Registries dialog.** `RegistryNotices` and the `plugins.registries` section with its heading off
  (`SettingsSection bare`: the title says it). The field's own description still says "Browse":
  it comes from the daemon's schema, and changing it is a daemon change. A registry that failed
  also shows a line on the page, or the failure would be hidden in the dialog. A hit on the field in
  the settings search still edits it in place, as before.
* **"Plugins in <dir>" moved.** The Installed section's description went with the section. The
  folder is still named in the empty state and the uninstall dialog, and the log's path in Logs.

## Verification

* Vitest: `model.test.ts`, `PluginsPage.test.tsx`, `stores/pluginRegistry.test.ts`,
  `catalog/model.test.ts`.
* `e2e/plugins-page.spec.ts` (focus into the dialog's setting, Escape), `e2e/plugins.spec.ts` (a
  surface from the row's menu, across routes). The full `make gui-e2e` suite.
* `make drive`: groups, details, both menus, search, Browse all, the Registries dialog, consent on
  first enable.
* `make drive DAEMON=dev` with `plugins/examples/hello` linked: the switch off and on, sampled every
  frame (busy, then settled, with no flick back); Restart with "Restarting…"; Reload; Logs, and
  Escape closing it with Settings left open.
