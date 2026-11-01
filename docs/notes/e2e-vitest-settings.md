# e2e → vitest: settings, themes, memory, update

Part of the plan in `e2e-unit-duplicates.md`: the assertions only Playwright made in this
area move into vitest component tests, then each e2e test whose assertions are all in vitest
now goes. 34 e2e tests went and 74 vitest tests came in. No product code changed except one
export, `ThemeCard` in `components/thread/ThemeCard.tsx`, so the card renders without a thread
item.

## What moved

* `components/settings/SettingsPage.test.tsx` (new): the real settings sheet over a small
  schema shaped like the daemon's. It covers the nav (schema pages, then the GUI's own), one
  page's sections at a time, an owned key (backdrop file) with no row, enum labels and the
  `(default)` mark in the list, the model/effort pair, units, restart hints and the
  restart-pending badge, dependent rows dimming with the across-section note, the saved toast,
  inline range errors, Escape and Enter on a number, hand edits and the load-error banner,
  reveal, and Escape closing the page. For Keybindings: Bound only buckets, "N more unbound",
  the shared "No shortcuts yet" card, the command-name tooltip and the persisted choice
  (localStorage round trip). For search: results, crumbs, marked keys, nav counts, a result
  that saves, Escape clearing then closing, a nav click clearing the search, and the Memory ›
  Remembered section hit for each of its keywords.
* `components/settings/BackdropEditor.test.tsx`: blob thumbnails, and removing the shown
  image when there are two.
* `components/confirm/ConfirmDialog.test.tsx` (new): a refused command shows the daemon's
  question with the command's button words; Cancel runs nothing; a second try confirms
  (`[false, false, true]`), as Forget all and thread Remove do.
* `components/sidebar/RowMenu.test.tsx`: Remove calls `removeThread`.
* `stores/intents.test.ts`: ShowView `settings`, `thread.next` (closes the sheet through
  `startViewSync`) and `help`.
* `components/memory/settings/RememberedSection.test.tsx`: an entry arriving on the stream
  (from the empty state), a forgotten row going with the event, Forget all's clear, a thread
  archived while the page is open, the second Forget after a stale refresh, the empty state's
  example, and the Forget tooltip.
* `components/update/UpdateDialog.test.tsx` (new): the dialog and the sidebar chip for every
  state, the busy-thread list following the threads store live, Install and Restart Now as
  one confirmed `app.restart`, Try Again, and `useCutOffThreadIds` (a stopped thread that was
  waiting does not count).
* `components/themes/ThemesPage.test.tsx` (new): the Themes page and editor in the sheet,
  with a fake daemon for the theme commands. It covers Choose… on a slot, Yours and Curated
  with origins, a search that keeps files that failed to load, a file's Delete, live arrival,
  the schema reload for the slot selects, preview, Back to current, Apply and the companion
  hint, the list's keyboard, Escape back to Settings, the scheme control, Customise (twice,
  saved, double-clicked), Delete, every editor view and filter (Pinned only, empty lines,
  group headers while filtered), stale pins, the save modal (stale, contrast, Fix and
  unfixable rows, refusals, name hints, light pair), the hex, L and H fields, a save from
  outside (Reload, Keep mine), Cancel on a selection change, and Ask the model (its context,
  its question over unsaved edits).
* `components/thread/ThemeCard.test.tsx` (new): the card's content, Undo and Undone, Edit,
  Apply and the badge, Undo hiding and coming back with the slot, a refinement's
  `theme.restore` with its tooltip, and the disabled "was deleted" Undo.

## What stayed e2e, and why

* settings.spec: cmd+, (the opening chord, and the trigger text without `(default)`, which
  is hidden by CSS), the dependent row's indent (geometry), `html[data-theme]`/`.dark` for
  the theme rows and the bool/enum test, the Radix select's keyboard focus, the keybinding
  recorder with the palette chord, cmd+= zoom, cmd+/ help.
* themes.spec: computed `--pane` and syntax colours, `html[data-theme]` after Apply, Escape
  and the scheme control, the palette-opened keyboard test, ShowView from the CLI with cmd+,.
* user-themes.spec: computed `--pane`, hover opacity of the row actions, deleting the theme
  in use (`html[data-theme]`).
* theme-editor.spec: the long edit test checks computed `--cf-canvas` on `<html>` after save.
* theme-editor-fuzz.spec: the width tests (geometry), Escape and focus handing back to the
  list, focus back on Save… after the modal, focus following the views.
* theme-model-flow.spec: the card test (`html[data-theme]`), the toast flow across the
  stream, Ask's focus in the popover and the thread opening, the daemon's save and check
  messages. The card's Apply and Undo-rule tests are now in vitest but stay because they also
  take the SHOTS screenshots (`theme-card-apply`, `theme-card-undo-*`).
* memory.spec: the search hit scrolling the section into view, and SHOTS.
* update.spec: the stream count (no `UpdateService/Watch`), and every flow that starts from
  the palette chord (check, download, daemon.restart's confirm, dev builds).

## Gotchas

* jsdom has no layout: `useWidth` stays at its initial 1200, which folds the theme list to a
  strip beside the editor. The test mocks it to 1600. `scrollTo` and `scrollIntoView` need
  stubs.
* Enter on a number setting commits on blur; jsdom only blurs a focused element, so focus it
  first.
* The editor deletes an unsaved Customise copy through `invokeCommand` directly, not
  `runCommandForResult`. Both go to the fake daemon.
* A theme card's Undo recomputes when the theme's history list changes. The daemon's event
  always carries a fresh list, so the test's event helper does too.
* The theme gallery is stubbed in `ThemesPage.test.tsx`. Rendering it made the file take a
  minute, and the tests only read the scope's `data-theme` and inline slots.
* Radix popovers do not move focus in jsdom: the Ask field's autofocus stays e2e.
