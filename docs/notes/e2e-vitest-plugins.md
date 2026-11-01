# e2e → vitest: plugins and skills settings

The first step of the move docs/notes/e2e-unit-duplicates.md planned: write the component tests
PluginsPage, ConsentDialog, the uninstall dialog, the secrets list, the failed-install line and the
Installed rows never had, then drop the e2e tests they cover. No product code changed.

## What moved

45 vitest tests, colocated:

* `components/plugin/settings/PluginsPage.test.tsx` (new, 13): the Installed rows (pills in order,
  pid, environment names without values, last error), Logs, Enable running plugin.enable, a
  surface's button running its show command, Update and where an install came from, the secrets
  toggle, list and delete (plugin.secrets.delete, then a re-read), the uninstall dialog (owned
  threads, what stays, purge, the daemon's real folders), "the plugins folder" until the daemon
  says where.
* `components/plugin/settings/BrowseSection.test.tsx` (+6): Refresh, a failed registry in words,
  a registry's skipped names, no registry (the link puts the caret in the setting), none listed,
  another registry winning a name, install steps, the failure line and its dismiss.
* `components/plugin/ConsentDialog.test.tsx` (new, 4): plugin.enable's presenter opens it, the
  title and permissions in the daemon's words, Cancel and Enable answering the confirm.
* `stores/pluginRegistry.test.ts` (+7): installPlugin (plugin.install for the ref, progress
  cleared, then plugin.enable unless enabled; a failure kept until the next try), uninstallPlugin
  answering its own daemon confirm (no second dialog) while the palette's gets the generic one,
  install-progress events and a registry epoch re-reading Browse.
* `components/skill/settings/SkillsPage.test.tsx` (+12): kind, state, source and version per
  row, a plugin's skills, Update with the kind, Run setup's tooltip, result counts and
  virtualising, "Nothing matches", a chip pressed during the typing wait, a Browse failure, the
  confirm's Cancel and Remove wording, Registries and its empty state.
* `components/threadinfo/PlaceGroup.test.tsx` (new, 3): the project row's mark and hover card
  for a plugin flag and a changed plugin environment.

## e2e removed (14)

* plugin-registry.spec.ts: Refresh, the second registry, Install with consent, Update, Uninstall.
* plugin-gaps.spec.ts: the secrets list, the failed install, the plugin folders.
* skills.spec.ts: Installed rows, Browse search, Install, Disable's confirm, Run setup's tooltip,
  Registries. The search's ranking and filters are the daemon's
  (`internal/store/skill/marketplace/search_test.go`); the e2e test was checking the mock's copy.

Each removal site has a comment pointing at the unit tests.

## Kept e2e, unchanged

* plugin-registry: no registry configured. Typing the registry into the setting has the daemon
  re-read Browse (settings → registry epoch over the stream).
* plugin-gaps: a flagged row opening the plugin's surface (the surface goes live over streams);
  the card's flags set and cleared through the daemon, card and sidebar following the stream.
* plugin-env-restart (both): staleness and Restart Claude through the daemon (the "Restarted
  Claude" item, the confirm only for a working turn). The card note, the title dot and the menu
  item are unit-tested (PlaceGroup, ThreadParts, ThreadMenuItems).
* plugin-owned (all three): the plugin's thread, composer and terminal live in its surface.
* plugins.spec.ts "Settings → Plugins lists them…": it ends with Settings closing as the
  plugin's surface opens in the panel. Everything before that is now unit-tested too, so a later
  split can cut it to that last step.
* skills: Run setup with a thread (Settings closes for the bottom panel); the settings search
  scrolling to the section (`searchGuiPages` itself is in settings/model.test.ts).

## Gotchas

* Tip on a disabled button's wrapper (Run setup): the span is not focusable, so the test sends a
  Tab keydown then `fireEvent.focus` instead of `tooltipText` (which calls `focus()`).
* jsdom has no `scrollIntoView`; the registry link test stubs it and puts it back with
  `onTestFinished`.
* PlaceGroup renders in jsdom with just the threads and projects stores; the hover card opens the
  way `tooltipText` does (a Tab keydown, then focus on the row).
