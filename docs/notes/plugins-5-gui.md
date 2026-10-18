# Plugins 5: the GUI (2026-10-18)

The fifth PR of the plugin stack (`docs/sketches/plugins/DECISIONS.md`, build order row 5),
on `cf/plugins-3-events-flags-env`. The GUI side of plugins: the view model and its
renderer for every v1 node, plugin surfaces as side-panel tabs, the consent dialog, and
Settings → Plugins (Installed). Frontend only: no Go, proto or migration changes.

## Layout (for PR 6 and PR 7)

| Piece | Where |
|---|---|
| View model (pluginsdk/ui's JSON, typed), proto → view mapping, RPC wrappers | `gui/frontend/src/api/plugin.ts` (the only file using `plugin_pb`) |
| Plugin list (EventService `plugin` source), surface manifests by kind | `src/stores/plugins.ts` |
| One `WatchSurface` per visible plugin tab, appends, toasts, drafts, collapsed sections, pending acts, Act | `src/stores/pluginSurfaces.ts` |
| `ShowView panel.plugin.<p>.<s>[?thread=…\|?project=…]` | `src/stores/pluginPanel.ts`, routed from `stores/views.ts` `showView` |
| Consent prompt (presenter of `plugin.enable` / `plugin.dev`'s confirm) | `src/stores/pluginConsent.ts`, `components/plugin/ConsentDialog.tsx` |
| Surface spec for every `plugin.<p>.<s>` kind (registry fall-through) | `src/surfaces/plugin.ts`; `surfaces/registry.ts` `surfaceOf` falls through to it |
| The tab body: header + view tabs pinned, state notices, body | `components/plugin/PluginSurface.tsx`, `Header.tsx`, `ViewTabsBar.tsx` |
| Node renderer registry | `components/plugin/registry.ts` (types), `nodes/index.ts` (the map), `nodes/*.tsx` (one per kind), `NodeList.tsx` |
| Shared pieces: inline spans, pills, glyphs, buttons, copy | `components/plugin/parts.tsx`, `actions.ts`, `tones.ts`, `format.ts`, `icons.ts` (allowlist), `form.ts`, `options.ts`, `log.ts`, `context.ts` |
| Plugin rows in the empty panel's surface list | `components/plugin/PluginSurfaceRows.tsx` (rows: `components/panel/SurfaceRow.tsx`, moved out of SidePanel) |
| Settings → Plugins | `components/plugin/settings/{PluginsPage,LogsDialog}.tsx`, `state.ts`; listed by `components/settings/guiPages.ts` |
| Mock daemon | `gui/frontend/mock/plugins.ts` (+ PluginService in `mock/server.ts`, the plugin source in EventService) |
| Tests | `api/plugin.test.ts`, `stores/plugins.test.ts`, `stores/pluginSurfaces.test.ts`, `surfaces/plugin.test.ts`, `components/plugin/{registry,form,format}.test.*`, `e2e/plugins.spec.ts`; fixtures `src/test/pluginFixtures.ts` |

### Node renderer registry

```ts
// components/plugin/registry.ts
export interface NodeProps<K extends NodeKind> { node: ViewNode; data: NodeData[K] }
export type NodeRenderer<K extends NodeKind> = ComponentType<NodeProps<K>>;
export type NodeRenderers = { readonly [K in NodeKind]: NodeRenderer<K> };
// components/plugin/nodes/index.ts
export const renderers: NodeRenderers = { text: TextNode, …, thread: ThreadPlaceholder, terminal: TerminalPlaceholder };
```

`NodeKind` is `keyof NodeData` in `api/plugin.ts`, so a missing renderer is a type error.
PR 6 adds `nodes/ThreadNode.tsx` and `nodes/TerminalNode.tsx` and changes the two lines in
`nodes/index.ts`. A renderer reads the surface's `ViewCtx` (`useViewCtx()`: watch key,
instance, version, plugin, view tab, the panel's `UiContext`, `inert`) and runs element
actions with `useRunAction()`.

PR 7's Browse section: `PluginsPage.tsx` has a `SectionCard id="browse"` placeholder to
replace.

## Decisions

* **Plugin list from the shared event stream**, not a second `PluginService.Watch`: the
  EventService `plugin` source already sends the snapshot first, then changes, removals and
  availability epochs (HTTP/1.1 connection budget). Every plugin event re-lists commands
  (debounced 50 ms).
* **Availability is the show command's.** `surfaces/plugin.ts` reads
  `plugin.<p>.show.<s>`'s `available` from the commands store when that store is listed for
  the panel's selection (context keys compared without the terminal, so focusing a bottom
  shell does not hide a tab); a list for another context reads as unknown (hidden in the
  list, "opening" in a tab) until the re-list lands. No predicate code in TS.
* **One tab per surface per panel, no params**: the panel's selection is the context. The
  tab id is the kind. `header.tabTitle` renames the tab in the strip (`retitlePanelTab`,
  new reducer `retitleTab` in `stores/panel.ts`).
* **Show commands are window-local presenters** (`keys/bindings.ts` `presentPluginShow`),
  like `view.panel.*`: from the palette or Settings they open the tab in this window
  without a round trip (and without a "delivered=1" toast). The CLI's runs on the daemon
  and reaches the GUI as `ShowView`, which selects `?thread=` (or the composer of
  `?project=` when the context's project differs), closes a page over the content area,
  and opens the tab.
* **Watch lifetime**: `PluginSurface` starts one `WatchSurface` (runStream, reconnecting)
  while the tab shows and the surface is not known to be unavailable here; the context is
  the selection's (`getUiContext(selection)`), restarted when it changes. Drafts and
  collapsed sections are per instance (the daemon's key), so they survive switching tabs.
* **Header and view tabs are pinned** (`sticky top-0` in the panel's scroll box) so the
  body (and VirtualStack lists over 40 rows) still scroll against `data-scroll-root`.
  Content inset 16 px (12 px under 340 px), list rows reach 8 px into it (DESIGN.md).
* **States**: opening (skeleton; the manifest's icon and title over "Loading…"), live,
  plugin down (notice in amber, red when failed, the last view dimmed with spinners
  stopped, nothing acts, "Restart <plugin>" for crashed and failed), not responding,
  failed, not available here, stream error. A host-rendered view (invalid plugin view) is
  drawn like any other: it carries the daemon's notice.
* **Buttons**: shadcn `Button` xs (ghost or outline) with the plugin's style as classes;
  no filled style. Events act (pending from click to the plugin's answer; its refusal is
  toasted with the daemon's message); commands go through `runCommandForResult` with the
  panel's context, so a confirming command shows the daemon's own dialog; `openUrl` and
  `copy` stay on the host.
* **Forms**: drafts hold only fields the user changed; a pristine field shows the plugin's
  value; a new `resetToken` drops the drafts; a submit the plugin takes drops them too.
  Host checks: required, max length, pattern (`u` flag; a pattern JS cannot parse is
  skipped). Secrets: typed only, sent only in a submit, never shown back ("Saved · type to
  replace" from `hasValue`). `change` events: selects and toggles at once, text on blur.
  `optionsSource` fills from the projects store or the non-archived threads.
* **Tabs** look like the pull request view's inner tabs; the clicked tab reads as active
  while its act is pending.
* **Consent**: `plugin.enable` and `plugin.dev` keep the daemon's `Confirm` +
  `DynamicConfirm` (the consent text) + `ConfirmIf`. `stores/confirm.ts` gained
  `registerConfirmPresenter`, and `invokeConfirmed` asks a command's presenter first, so
  both commands (from Settings, the palette or an InvokeCommand intent) show the consent
  dialog, which lists the text's "  - " lines as permissions and says when a known plugin
  asks for more than its grant.
* **InvokeCommand** (a plugin's `host/invoke` with `confirm: "ask"`) runs
  `runCommandForResult` with the intent's context; the confirm (or consent) dialog says
  "Asked by <plugin display name>" (`ConfirmRequest.caller`).
* **Settings → Plugins** is a GUI page after the schema's pages (`guiPages.ts`): it shows
  state, not settings-file fields, so the daemon's schema has none. Rows: name, version,
  dev badge, state pill (Running emerald, Crashed amber, Failed red, Disabled muted), pid and
  restarts, disabled reason, last error, issues, dev path; "Open <surface>" per surface
  (its show command, dimmed when unavailable for the selection); the session environment
  (`PluginService.Environment`, re-read on plugin changes) with "New threads get this;
  running threads keep what they spawned with."; Enable (amber outline, the consent
  dialog) / Disable / Restart (commands) and Logs (a dialog over `PluginService.Logs`,
  re-read every 2 s). "Add a dev plugin" opens the palette on `plugin.dev` (path
  completion and the folder picker). Browse: a placeholder.
* **Icons**: an allowlist of 82 lucide names (`components/plugin/icons.ts`); others draw
  a circle. The plugin skill should list the same names (not done here: PR 4's files).

## Deviations

* **Screenshots are the frontend in WebKit (Playwright) against a real isolated daemon**
  (`CODE_FOUNDRY_HOME=/tmp/cfp5`, `plugin dev plugins/examples/hello`), not the Wails
  window: a Wails copy shares the installed app's WebKit localStorage
  (`~/Library/WebKit/dev.alexwaumann.codefoundry`, gui-screenshot gotcha) and panel
  widths and tabs would land in Alex's real app state. Same frontend build, live data.
* No `PluginService.List` call on connect: the event source's snapshot is the list.
* The plugin header icon is always muted (DECISIONS rule 7); the Settings row uses the
  plugin's first surface icon, else a puzzle.
* `useEscapeCloses` now leaves an Escape inside any `[role="dialog"]` alone (the Logs
  dialog over Settings closed Settings too).

## Gotchas

* `Nodes.tsx` next to a `nodes/` folder collides on a case-insensitive disk: the list is
  `NodeList.tsx`, the registry `nodes/index.ts`.
* The tooltip guard (`lib/tooltips.test.ts`) flags any `title=` prop on a component: the
  renderer's props are `heading`, `fallbackTitle`, `displayName`.
* `react-hooks/static-components` refuses `const Icon = pluginIcon(name); <Icon/>`:
  plugin icons render through `<PluginIcon name=…/>` (a map lookup inside).
* Vitest reads the daemon's captured views with `?raw` imports; `vite.config.ts` allows
  `internal/store/plugin/testdata/hello-demo`.
* The real hello demo instance outlives a tab by the 60 s grace: reopening finds the tab
  it was on.

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=/tmp/cfp5`)

```
make build plugins
CODE_FOUNDRY_HOME=/tmp/cfp5 ./bin/code-foundry daemon --dev &      # without the session's CLAUDE* vars
code-foundry plugin dev plugins/examples/hello --yes --follow=false
# /tmp/cfp5/plugins/crasher (bin/crash exits 1) and acme-data (never consented), then
code-foundry plugin reload && code-foundry plugin enable crasher --yes
code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --name "Ship the plugin GUI" --created-by=
cd gui/frontend && vite --port 9311   # opened as /?daemon=http://127.0.0.1:<port>&token=<token>
```

In the GUI: the palette's "Show Hello Demo" opened the tab (titled "Hello" from
`tabTitle`), the three view tabs switched through the real plugin, Start build streamed six
appended lines, the form's Save went to the plugin, Settings → Plugins showed hello
running with `CF_HELLO=1`, crasher failed after five crashes with its last error, and
Enable on acme-data showed the daemon's consent text in the consent dialog. Screenshots
(dark and light, 400 px and 280 px) are on the `cf/plugins-5-shots` branch.

## Open

* No click-through from a flagged sidebar row to the plugin's surface; the thread header
  does not show flags.
* A thread that ran before a plugin's environment changed keeps it; there is no "restart
  to pick up" button (the Settings row says so in words).
* Plugin secrets (`plugin secrets list/delete`) are not in Settings yet.
* The icon allowlist is the GUI's only; the skill (PR 4) and the SDK validator do not
  know it.
