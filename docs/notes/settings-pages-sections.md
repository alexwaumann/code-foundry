# Settings pages and sections

Settings had grown a long General page and an Appearance page that held layout behaviour, and
the GUI's own pages (Plugins, Skills, Memory) sat after Advanced. This step reorders the pages
and moves sections. Display only: no `settings.toml` key, group or table changes, so every
existing file keeps working.

## The pages, in nav order

1. General: Threads (model and effort, New threads work in, Name threads automatically), Text
   generation, **Snooze** (new: Default snooze, Save idle threads for later, Archive saved
   threads), Events in “Until event”, Files, Updates.
2. Appearance: Theme, Window, Terminal.
3. **Layout** (new): one untitled section, `layout/panes`, with Threads open as first and Smart
   swap right below it (the switch that Threads open as forces on), then Smart placement, Thread
   info by default and Needs you lists.
4. Notifications.
5. **Dictation** (new): one untitled section, `dictation/dictation`, the fields and the GUI's
   rows as they were under General (Model, the hold key's permission, the Advanced disclosure).
   The old section description is now the page description.
6. Source control.
7. Keybindings.
8. Plugins, then the GUI's Skills and Memory.
9. Ember: the Epochs section is now **Fresh sessions** (id `sessions`).
10. Advanced: Executables, **Threads** (new: Prompt cache lifetime and Close grace, from General's
    old Lifecycle section), Logging. Always last.

## Decisions

- **Section ids are display ids**, so they were renamed where the meaning changed:
  `general/snooze` is now the Snooze section, and Events in “Until event” is `general/until-event`
  (`sectionBodies.ts`); `general/lifecycle` is gone; `ember/epochs` is `ember/sessions`.
  `sectionLinks.ts`, `sectionRowSearch` and `advancedFields.ts` use `dictation/dictation`.
- **The GUI's own pages follow Plugins.** Plugins is a schema page now placed before Ember. A
  GUI page that the schema lacks goes right after the GUI page before it in `guiPages.ts`
  (`model.ts settingsPages`), so Skills and Memory follow Plugins and Advanced stays last with no
  schema stubs for them. `view.settings --page` lists its ids by the same rule
  (`SettingsGUIPages` in `internal/command`), so its error names the pages in nav order.
- **An untitled section is found by its page's name.** Dictation's Model row was found by its
  section's title; with the section untitled, `searchSectionRows` matches on the page title too,
  and a section hit is labelled with the page title alone (no trailing “›”).
- `staticFields` (Go) and the mock's fields are reordered so field order is still display order;
  `TestPageLayout` and `mock/settingsLayout.test.ts` pin the pages, sections and their fields.
- Places that name a moved path were updated: the Threads open as notice (Settings › Layout ›
  Threads open as), dictation's refusals (Settings → Dictation), GETTING-STARTED.

## Gotchas

- `TestPages` checks every section has fields, so an untitled single section is still needed on
  Layout and Dictation; the GUI-only rows (Dictation's Model) hang off it.
- The auto-tidy notice and “Choose what shows here…” still open General: both settings stayed
  on that page.
