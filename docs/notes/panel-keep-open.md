# Keep the side panel open when its last tab closes

Decided 2026-10-19 (Alex). A setting, off by default, so closing a side panel's last tab
can leave the panel open on its "Open a surface" page (the page the "+" shows) instead
of hiding it.

## What changed

* **Setting `appearance.panel_keep_open`**: bool, default `false`, live. Appearance page,
  Window section, after Backdrop. Title "Keep side panel open"; description "When its
  last tab closes, the side panel stays open on the new tab page instead of hiding."
  It binds to `Settings.Appearance.PanelKeepOpen`. Older `settings.toml` files without
  the key get the default from the schema like every other field (`resolve`), so no
  migration. The Playwright mock (`gui/frontend/mock/settings.ts`) mirrors it, and the
  frontend has it as `KEYS.panelKeepOpen`. The Appearance group's description now ends
  "backdrop, and the side panel".
* **`closeTab(e, id, keepOpen = false)` stays pure.** With `keepOpen`, closing the last
  tab returns `{ open: e.open, tabs: [], activeTabId: null }` (picking ends, `pickFrom`
  goes, width and expanded stay). It keeps `e.open` rather than forcing `true`, so a
  hidden panel losing its last tab is not shown. Every other case is the same with the
  flag on or off.
* **Where the flag is read:** `closePanelTab` (stores/panel.ts) reads it from the
  settings store (`panelKeepOpen()` in stores/settings.ts) each time a tab closes, so a
  change applies at once. `opts.keepOpen` overrides it, for tests and any future caller
  that must hide. Every path that removes a side panel tab goes through `closePanelTab`:
  the tab's ×, middle click, and cmd+w on the active tab (all in SidePanel.tsx).
* **Focus:** when the panel had the keyboard and is kept open with no tabs, SidePanel
  asks it to take focus back (`panelFocusSeq`), because the × or tab that had focus is
  gone. cmd+w then hides it and the surface letters open a surface, as on any empty
  panel. When it hides, focus still goes to the content pane as before.

## What still hides the panel

* cmd+w on a panel with no tabs (`panelKeyAction` returns `hide`), whatever the setting.
* The panel's toggle button, `view.panel.toggle`, and cmd+w while picking (that goes
  back to the tab it came from instead, as before).
* Archiving or snoozing a thread resets its side panel to the empty closed entry
  (stores/archiveCleanup.ts). That is a reset, not closing a tab, so the setting does not
  apply.

## Gotchas

* **No plugin or events path removes side panel tabs.** The brief pointed at the
  comments in stores/events.ts (the `terminal` handler, and `closeEmptyPanels` after a
  reconnect). Those hide the **bottom** terminal panel when its last shell goes
  (stores/bottomActions.ts `hideEmptyBottom`). They do not touch the side panel. A plugin
  whose surface becomes unavailable keeps its tab, which shows "Not available here"
  (PluginSurface.tsx). So the setting has no events path to honour, and the bottom panel
  is unchanged: the setting is about the side panel only. If a later change removes side
  panel tabs from an event, it should call `closePanelTab` so the setting applies.
* The empty panel's header has no tab strip, so there is no "+" to highlight. The body is
  the same `panel-empty` surface list the "+" shows.

## Tests

* `stores/panel.test.ts`: the closeTab table runs with the flag off (default and
  explicit `false`) and has a keep-open table (last tab, last tab with width and
  expanded, last tab of a hidden panel, non-last tabs, picking cases, unknown id).
  Store tests cover `closePanelTab` reading the setting: no snapshot, missing key, off,
  on, explicit overrides, a live change, and togglePanel still hiding a kept panel.
* `components/panel/SidePanel.test.tsx`: × with the setting off hides and focuses the
  content; × with it on leaves `panel-empty` showing with focus on the aside; cmd+w
  closes the last tab and stays, then cmd+w hides; middle click on the last tab stays.
