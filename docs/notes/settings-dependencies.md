# Settings dependencies and search

PR 3 of the messaging and settings overhaul: which settings follow a switch, how a page and
the search show them while it is off, and two search rows that drew the wrong editor or words.

## Decisions

- `dictation.anywhere` depends on `dictation.enabled`, like every other Dictation setting: the
  GUI host only acts on it while dictation is on (`gui/dictation.go`). It joins
  `HIDDEN_WHILE_OFF`, so the Dictation page shows the switch (and the Model row) alone while
  dictation is off. A field that leaves with its switch is never indented under it
  (`hiddenWhileOff`): Dictate anywhere sits right under the switch, and an indent there alone
  would set it apart from the rows below it.
- `HIDDEN_WHILE_OFF` hides fields from their page only. The search finds them, dimmed, with
  "Not used while Dictation is off.", so searching "bluetooth" or "hold key" while dictation is
  off still answers. With that, the search hides nothing: `hiddenFieldKeys` lost its `from`
  argument and `searchSettings` its `hidden` set.
- Every search hit whose parent leaves it unused dims and says why, bool dependents included
  (before, only `dependsOnValue` ones did). A hit is away from its parent, so the note stays.
- Ember's six child settings (`ember.model`, `ember.effort`, `ember.worker_models`,
  `ember.worker_effort`, `ember.epoch_context_tokens`, `ember.epoch_max_hours`) depend on
  `ember.enabled`. Cooldown and auto pull were left alone on purpose.
- On the Ember page they dim with no note: six "Not used while Enable Ember is off." lines would
  be clutter, and the switch heads the page. The rule is structural, not a list: a page's first
  field, when it is a bool, is the page's switch (`pageSwitch` in `SectionCard.tsx`), and its
  dependents elsewhere on the page dim quietly. Any other dependent in another section still
  says why on the page.
- A pair row (`SettingRowPair`, Ember's model and effort) dims as one by its first field's
  parent: both cells and the shared description, editors still usable and full strength on
  hover or focus, like `SettingRow`. It takes a note too, unused today.
- `threads.snooze_events` registers `SnoozeEventsEditor` in `keyEditors.ts`, as
  `files.include_ignored` does: the search row shows the same checkboxes as the page, in a box
  of their own, instead of a text box of space-separated words. The section and the editor
  share `useSnoozeEvents` and `EventRows`.
- `layout.threads_open_as` leaves `ownDescriptionKeys`, which was its only entry, so the
  mechanism is gone: the row says what the picked option does, like every explained enum. The
  schema's description ("With Panes or Single, linked panes always follow…") is unchanged; the
  CLI, the guide and the search still show it.

## Gotchas

- `SettingsPage.test.tsx` adds Dictation and Ember fields in its own describe's schema, so the
  shared fixture (and the nav-order test) is untouched.
- The pair's dimmed state is on each cell's `data-dimmed`; the pair's wrapper has none.
