# Plugins layout 3: toolbar, footer and container (2026-10-19)

PR 3 of the plugin layout series (PR 1: `plugins-layout-1-columns-pane.md`). Two view
slots pinned around the scrolling body, and a node that caps its width for the coming
main-pane pages.

## What shipped

| Part | Where |
|---|---|
| `View.Toolbar`, `View.Footer`, `View.NodeLists()`, `MaxStripNodes`; `Container{Width, Children}`, `ContainerNarrow/Wide/Full`, `ContainerNarrowWidth`, `ContainerWideWidth`; `NewContainer` | `pluginsdk/ui/ui.go`, `build.go` |
| Validation: strips (count, kinds, a strip form's fields), container width, depth message, `StripKinds` | `pluginsdk/ui/validate.go` |
| Host walks the whole view (`walkView` over `NodeLists`, then `Children`): logs, acting elements and permission checks, owned nodes, `[]` lists, the invalid-view notice keeps the strips; capabilities `view.node.container`, `view.toolbar`, `view.footer` | `internal/store/plugin/surface.go`, `surface_act.go`, `threads.go` |
| GUI types, `VIEW_LISTS` / `viewNodes` (every walk), `SurfaceFrame` (the surface's own scroll area between the strips), `ToolbarBar`, `FooterBar`, `StripRow`, `strip.ts`, a form's strip layout, `ContainerNode` | `api/plugin.ts`, `stores/pluginSurfaces.ts`, `components/plugin/` |
| Hello demo Layout tab: a toolbar (search form, status chips with counts) that filters the runs, a footer (count, Clear filter, Run again), the body in a wide container; recaptured `hello-demo/layout.json`; the mock filters it too | `plugins/examples/hello/layout.go`, `gui/frontend/mock/plugins.ts` |
| Skill: `ui-layout.md` sections for both, primitives.md links, limits rows | `internal/skills/` |

## Decisions

* **Slots, not nodes.** `toolbar` and `footer` are optional lists on the view (left out
  of the JSON when empty, so an older GUI never sees them). The toolbar sits under the
  header and the plugin's tabs, the footer at the bottom of the surface.
* **Per view tab.** They are part of the view the plugin sends for the active tab, like
  `nodes`; the host persists nothing of them across tabs. A tab whose view has none shows
  none; a toolbar meant for every tab is sent with every tab's view. Form drafts in a
  strip are per instance and tab like the body's (the draft key has the tab), so the
  same search field on two tabs keeps two drafts. This is the simplest rule that matches
  how tabs already work; a shared slot would need a second tab-independent view part.
* **Cap: 6 nodes each** (`MaxStripNodes`), kinds `text`, `chips`, `actions`, `progress`,
  `form`, and PR 2's `divider`, `spacer`, `group` (`StripKinds`; PR 2 merged while this
  was in review and the rebase added them). A strip form's fields are inputs, toggles and
  dropdown selects: fieldsets and `"style": "list"` selects are refused (they are
  vertical). In a row a divider is a vertical 20 px hairline and may not have a label; a
  spacer is `size` px across, a flex spacer takes the row's free width (what follows sits
  at the end); a group is its own line (one not aligned to the start takes the free
  width to align in). Strip nodes are top-level nodes (depth 0), count toward
  `MaxElements` and share the view's keys. The GUI draws at most 6 as well.
* **One row that wraps** (`flex-wrap`, 8 px apart, 6 px between lines). A form and a
  progress bar grow (`flex-1`, at least 160 / 96 px), an end-aligned actions bar gets
  `ml-auto`, text and chips are as wide as their content. In the panel a search field and
  four chips take two lines; widened, one.
* **A form in a strip** keeps its semantics (drafts, Enter, Escape, submit locks, `busy`,
  `resetToken`, settle on the next view) and only changes layout: fields in a row, text
  inputs and selects with an `sr-only` label (give a placeholder) and no description, a
  toggle's label beside its switch, field errors under the control, the form error on a
  line of its own under the row (`basis-full`).
* **PR 2's flex spacer still reaches the body's bottom**: `SurfaceFrame`'s inner wrapper
  grows to the scroll area's height and the body's list is the box list, as PR 2 had it
  on the old panel-scrolled surface.
* **The body scrolls between the strips.** The panel's body used to be the scroll box
  with a sticky header. Now `SurfaceFrame` makes the surface fill the panel's body (which
  no longer scrolls) and owns a scroll area (`data-scroll-root`, `plugin-scroll`) between
  the pinned top (header, tabs, toolbar) and the footer. `fillBoxOf` and `useOnScreen`
  already take the nearest `[data-scroll-root]`, so fill nodes now end 16 px above the
  footer and live nodes count as on screen only between the strips. A fill node at the
  body's top gets the same height as before when there are no strips (the area is the
  panel less the header instead of the panel with the header inside it).
* **Chrome**: each strip has the panel's padding (`px-4 py-2`, 12 px under 340 px) and a
  `border-pane-border` hairline toward the body (toolbar `border-b`, footer `border-t`),
  `bg-pane`. While the plugin is down both dim like the body.
* **Container**: `narrow` 680 px, `wide` 1080 px (`max-width`, `mx-auto`, `w-full`),
  `full` (default) no cap. In the panel every value is effectively full; the cap applies
  in a widened panel now and on pages later. It counts as a container for `MaxDepth`
  (message: `inside 5 containers (section, columns, pane, container), at most 4`), lays
  its nodes out like the list around it, and is not a fill box.

## Tests

* Go SDK (`chrome_test.go`): `NodeLists` has every `[]Node` field of `View` (reflection)
  in order and shares arrays; a table for every strip branch (each kind in each strip, 6
  and 7, fieldset, list select, divider label, a bad spacer, a group of a refused kind, kindless and two-kind nodes, a bad node and button inside,
  keys shared with the body and across strips, form names across strips); every
  non-strip kind refused by name in both strips; strips at 400/401 elements; container
  widths and errors; JSON shapes and omission; `TestChromeNumbersMatchTheGUI` (680, 1080,
  6, the kinds list vs `layout.ts` / `strip.ts`). PR 1's reflection tests caught the new
  kind and container until they were registered (17 kinds, `containers["container"]`);
  the fuzz seed has a container and both strips, and `TestFuzzSeedsCoverEveryKind` now
  requires a toolbar and a footer too.
* Daemon: the `every` view has strips (a toolbar submit, a chip, a footer command) and a
  container; `TestStripsAndContainerWalked` (canonical `[]`, indexing, permission and
  secrets checks in strips, refused kinds, the invalid-view notice keeps the strips and
  steps around a strip key); the fuzz append walk covers the strips; owned nodes inside a
  container.
* Hello: `TestLayoutChrome` (filter by text and status, counts, Clear filter's reset
  token, Run again's toast, other tabs without strips).
* Vitest (`chrome.test.tsx`): the frame's order and classes, hairlines, dimming, the row
  (order, the cap of 6, item classes, a vertical divider, fixed and flex spacers across, a
  group), a strip form's layout vs the body's, errors, a
  footer form's drafts / submit lock / busy, the demo's strips, container widths and
  spacing, and fill between the strips (body box, not the panel). PR 1's `layout.test.tsx`
  now renders inside `SurfaceFrame`; store walks (strip forms reset and settle, appends,
  unknown kinds), API helpers, registry, fuzz (renders the strips).
* e2e (`plugins.spec.ts`): the strips under the tabs and at the panel's bottom with 1 px
  borders and 16 px padding, the body (not the panel) scrolls with the strips fixed,
  filtering by Enter and a chip, Clear filter drops the draft, another tab has none; PR 1's
  case now checks the thread's fill pane ends 16 px above the footer.

## End to end (isolated `CODE_FOUNDRY_HOME=~/.cfpl3`)

```
make build plugins
CODE_FOUNDRY_HOME=~/.cfpl3 ./bin/code-foundry daemon --dev &      # without CLAUDE* vars
code-foundry settings set threads.default_model 'claude-haiku-5-5[1m]'
code-foundry plugin dev plugins/examples/hello --yes --follow=false
code-foundry thread new --no-project --name "Layout chrome" --created-by=
code-foundry plugin act hello demo tab --key layout --thread s-49bf52be0ed8
code-foundry plugin surface hello demo --thread s-49bf52be0ed8 --settle 2s --json   # the fixture
cd gui/frontend && vite --port 9381   # WebKit (Playwright) at /?daemon=…&token=…
```

Screenshots (dark and light, `plugins-layout-3-chrome/`): the panel at its default width
with "main" typed and Passed chosen (the search over the chips, the body scrolled under
the toolbar, the count and actions in the footer), then widened by 560 px (one toolbar
row, columns side by side, the thread's fill pane ending above the footer). No messages
were sent; the daemon was stopped and `~/.cfpl3` removed.

## Gotchas

* `vi.mock("@/api/plugin")` with `importOriginal` stubs `actOnSurface` for the footer
  form's submit test; the store's `actOnElement` needs a watch entry with an instance and
  a version first.
* A mouse wheel over the Layout tab's body lands on its 320 px pane (`overscroll-contain`),
  so the e2e scrolls the body with `scrollTop`.
* The fixture is recaptured from the real plugin; its ids and opened time were set back
  to the other five fixtures' so the mock's patches and time shift apply.
* Rebased onto main after PR 2 (#229): conflicts in the Node union, the kind and depth
  messages, `Children`, `fillLists`, capabilities, the `every` view, `childLists`, the
  mock's walks, `nodes/index.ts`, `PluginSurface.tsx` (PR 2's grow/box body inside the
  new frame), the hello Layout tab (PR 2's grid, groups and spacers now sit in the wide
  container) and `ui-layout.md`. The fixture was recaptured once more and the
  screenshots retaken after it.
* A full `make gui-e2e` on the pre-rebase branch hit `ENOSPC` (disk briefly full while
  other agents ran suites) in five unrelated specs and was cancelled; after the rebase only
  the plugins spec ran (11 passed), per Alex.
* `TestSurfaceNotRespondingAndPluginDown` failed once under the parallel `go test` load
  ("not open (watch it first)") and passed five times alone: a timing flake, unrelated.
