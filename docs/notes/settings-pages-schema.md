# Settings pages in the schema (settings reorg, PR 1 of 2)

Status: daemon and schema side done on branch `t3/settings-1-schema`. The GUI still renders
the old group sections; PR 2 builds the tabbed page from `pages`. Design sketch:
`/tmp/settings-sketch` (DESIGN.md, sketch.js), not in the repo.

## What changed

* **Pages → sections → fields, display only.** `settings.Pages` lists six pages in order
  (General, Appearance, Notifications, Source control, Keybindings, Advanced), each with
  its sections. Every `Field` carries `Page` and `Section`; `Group` stays the TOML table.
  No key moved and nothing migrates: `threads.scrollback_lines` is in `[threads]` but shows
  on Appearance › Terminal, `update.channel` shows on General › Updates,
  `gitops.editor_command` on Source control › Repositories.
* `staticFields` is now in display order (page, section, then row order). That reorders
  keys inside a few tables when the file is rewritten (`[appearance]`, `[github]`); tables
  themselves still follow `Groups`.
* New field hints: `Unit` ("s", "pt", "%"; the number input's suffix, so titles lost
  "(seconds)"), `DependsOn` (a Bool key; naming model on auto-name, alert volume on alert
  sound), `Row` (model and effort share row "model"; the first field's description goes
  under the row). The file's comments spell the unit out ("Range 60 to 86400 seconds.").
* EnumLabels for effort (Low, Medium, High, Extra high, Max: "Extra high" like the
  composer's `EFFORT_CHOICES`), density, thread width, backdrop and log level. Every static
  enum is now labelled.
* Copy trimmed to one or two plain sentences, from sketch.js. The cache lifetime now says
  it describes the API and that the app only predicts expiry from it.
* Proto: `SettingPage`, `SettingSection`, `GetSettingsSchemaResponse.pages`, and
  `SettingField.page/section/unit/depends_on/row` (13–17). `groups` stays (file order).
* `settings.Service` gains `Pages()`; the keybindings page's sections are built from the
  commands (`pages(cmds)`), so `Pages` itself has none for it.
* GUI: `SettingFieldView` gains page, section, unit, dependsOn, row; new
  `SettingPageView`/`SettingSectionView`; `SettingsSchemaView.pages`. The mock daemon
  mirrors all of it (`mock/settings.ts` `staticPages`, `NO_KEYBINDING`, `pages()`).

## Keybindings

* Field title is the command title alone (no "Category: " prefix); placeholder is still
  the command name, description the command's.
* Section id is the category slug (`"Pull Request"` → `pull-request`), title the category.
  Sections are in the palette's order, which is alphabetical by category
  (`groupByCategory`, `Registry.List`). The sketch's hand-picked order (Thread, View, Pull
  Request, …) was not adopted: the brief asked for the palette's order, and one order for
  both keeps the two lists recognisable. PR 2 can reorder client-side if wanted.
* **`command.Command.NoKeybinding`** marks commands a chord is no use for. The registry
  refuses `NoKeybinding` together with default `Keybindings`. It travels through
  `settings.CommandInfo.NoKeybinding`; such a command gets no keybinding field and no
  snapshot value, and an override for it in the file is rejected ("thread.list cannot have
  a keybinding") and the key is an unknown setting for `Update`. The palette still lists
  them. `TestNoKeybindingCommands` pins the list, so a new command is bindable unless it
  is added there.

### Unbindable commands (27)

| Kind | Commands |
|---|---|
| Listings / prints | `action.list`, `action.runs`, `terminal.list`, `theme.list`, `thread.list`, `thread.items`, `thread.agents`, `thread.mcp`, `thread.commands`, `workspace.list`, `workspace.members`, `usage.show` |
| Status / version queries | `app.version`, `daemon.status`, `daemon.version` |
| Settings verbs (the page does these) | `settings.get`, `settings.path`, `settings.set`, `settings.reset` |
| Waits | `action.wait` |
| CLI drives the GUI | `ui.notify`, `ui.focus.repo`, `ui.focus.terminal`, `ui.palette.open` (cmd+k / cmd+shift+p are reserved for it already), `thread.focus`, `view.open.url` |
| Needs a request id / answer | `thread.respond` (the thread view answers inline) |

Kept bindable on purpose: `thread.send` (prompts for text in the palette),
`settings.reveal`, `theme.set-dark`/`theme.set-light`, `view.usage` and the `view.panel.*`
surfaces, `action.add`/`edit`/`remove`/`run`, every `pr.*`, `repo.*`, `app.*` and
`daemon.restart`.

## Tests

* `TestPages`: every field's page and section exist in `pages()`, no section is empty or
  split, only a page's single section is untitled, rows stay in one contiguous run of one
  section, `DependsOn` names a top-level Bool field, units only on Int fields, every
  `*_seconds` key has unit "s", no title says "(seconds)".
* `TestKeybindingFields`: NoKeybinding commands left out, titles, sections and the
  keybindings page's sections (a category with only unbindable commands, Daemon in the
  fixture, gets none).
* `TestNoKeybindingCommands` (internal/command) pins the list above; the uniqueness test
  is unchanged and green.
* API test covers the new attributes and the page order.

## Gotchas

* `settings get` (CLI) lists keybinding keys from the schema, so `keybindings.thread.list`
  and friends no longer appear there.
* e2e `settings.spec.ts` picks thread-width options by label now ("Full", "Comfortable
  (default)"), since that enum gained labels.
* Category titles come from the registry; two categories that slug the same would share a
  section id. None do.
