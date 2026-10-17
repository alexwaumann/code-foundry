# Settings pages (settings reorg, PR 2 of 2)

Status: the GUI renders the settings page from `schema.pages` (PR 1, #146,
`docs/notes/settings-pages-schema.md`). Variant B of the sketch (`/tmp/settings-sketch`, tabs);
not in the repo.

## What changed

* **Tabs.** A left nav lists the pages with a lucide icon each (`pageIcons` in
  `SettingsPage.tsx`; an unknown page gets a gear) and marks the current one
  (`aria-current="page"`). Only the current page renders. The page lives in the views store
  (`settingsPage`, `setSettingsPage`): `showView("settings")` opens on General, and closing the
  Themes page goes back to Settings on the page it was opened from (Appearance). Nothing
  deep-links into a group or key today (checked `showView`, `openThemes`, the CLI's ShowView
  names), so there was nothing to map.
* **Page body.** `text-title` page title, optional description, then one card per section:
  `text-subheading` title and caption above a `rounded-lg` bordered card, rows separated by
  hairlines (`rowBorder`). Pages with a component of their own register in `customPages`
  (only Keybindings); the rest are `FieldsPage`.
* **Rows.** Same 2-column grid and editors; the raw key is gone from the row (search shows it).
  `useSettingField` (value, save, error, editor) is shared by the full row, the paired row and
  the keybinding row; the per-type editors moved to `editors.tsx`.
  * `unit`: number inputs are 8.5rem, right-aligned, no stepper arrows, the unit a muted
    suffix inside (`setting-unit`).
  * `dependsOn`: right under its parent the row is indented 24px with a hairline elbow and no
    separator; it dims (`opacity-45`, `data-dimmed`) while the parent is off. The editor stays
    usable, and hovering or focusing it lifts the dimming. A dependent in another section (naming
    model under Text generation, its toggle under Threads) is not indented; while dimmed it says
    "Not used while Name threads automatically is off." (DESIGN.md's call).
  * `row`: model and effort side by side, each title above its select, the model's description
    under the pair (`SettingRowPair`, `data-setting-row`). Only adjacent fields join.
  * Selects show the value alone; " (default)" is only in the open list (a span hidden inside
    `select-value`), as DESIGN.md asked.
* **Appearance › Theme** ends in a "Browse themes" link row (`sectionLinks`, keyed
  `page/section`; `settings-themes-link`), replacing the nav link.
* **Keybindings page.** Sections are the schema's categories. A "Bound only" switch beside the
  title (on by default, persisted in localStorage `code-foundry.settingsPrefs`). Rows are one
  line: title (tooltip: description + command name), recorder, reset. `bucketKeybindings`
  sorts them: with Bound only, each category with something bound shows those and an
  "N more unbound" expander; categories with nothing bound fold into one "No shortcuts yet"
  card of collapsed category rows that open in place. The description ends in "N of M commands
  have a shortcut." from the data (M counts bindable commands only, since PR 1 dropped the
  NoKeybinding ones). Unbound recorders read "Add shortcut".
* **Search.** With text, the nav shows per-page counts (zero dimmed, no current page) and the
  body is one flat card of matches across every page (`searchSettings`): a count line, and per
  row a "Page › Section" breadcrumb, the title and description with the words marked, the key in
  mono with the words marked, and the usual editor. Esc (in the box or anywhere outside a
  field) clears the search; Esc with nothing to clear closes Settings. Clicking a nav item
  while searching clears the search and opens that page. Matching is unchanged: every word in
  title, description or key.
* Banners stay at the top of whichever body shows.

## Deviations from the sketch

* **Category order** stays the schema's (alphabetical, the palette's), not the sketch's
  Thread, View, … order, per PR 1's decision. With Bound only that puts Git first.
* **Chords** render as the recorder's text (`⇧⌘Y`), not as one Kbd chip per key; the
  recorder is the existing shadcn outline button, 7rem minimum.
* **Keybindings in search results** are full two-column rows (breadcrumb, title,
  description, key), not the one-line keybinding row, so the result card has one kind of row
  (DESIGN.md's open question about "panel" interleaving).
* **Browse themes** is not a search result (it is not a field).
* **Pair row** spans the card, so model and effort selects are wider than other selects.
* Page and search counts use the type roles: `text-title` for page titles (the sketch's
  size), `text-heading` for the result count.

## Gotchas

* `react-refresh/only-export-components`: a file that exports components may not export a
  hook or a constant, hence `useSettingField.tsx`, `editors.tsx`, `sectionLinks.ts` and the
  helpers in `model.ts`.
* The search box used to swallow Esc when empty (useEscapeCloses ignores inputs); its own
  keydown now runs the same clear-or-close.
* Playwright's `toHaveText` reads `textContent`, which includes the hidden " (default)" in a
  trigger; the e2e checks the trigger with `useInnerText`.
* The enum keyboard e2e needs a 1100px tall viewport: Thread width now sits low on the
  Appearance page and its list flipped above the trigger.

## Tests

* `model.test.ts`: query words, field matching, highlight runs (overlaps merge), page
  sections, row pairing, cross-page search order and counts, `isBound`, keybinding buckets
  with and without Bound only.
* `themePicker.test.ts`: Settings opens on General, Themes returns to the page it came from.
* e2e `settings.spec.ts`: page switching and reopening on General, the model/effort pair,
  dependent rows (both kinds), Bound only (expander, folded card, tooltip, persistence),
  search (counts, breadcrumbs, marked key, editing a result, Esc twice, nav while searching),
  Browse themes and back. Older specs open the page they need; `themes.spec.ts` and
  `zoom-popovers.spec.ts` go to Appearance first.
