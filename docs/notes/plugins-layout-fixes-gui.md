# Plugins layout: GUI fixes from the fuzz passes (2026-10-19)

Fixes the GUI findings of the layout fuzz pass over PRs #221, #229, #233 and #236 (the
generator, harness and probes came with the fuzz branch, `cf/layout-fuzz-gui`) and the
GUI findings of the live-daemon pass (numbered "live N" below). The Go SDK and daemon
findings (live 3, 11, 12) are another PR's.

The regression suite stays: `src/test/layoutFuzzGen.ts` and `layoutHarness.tsx`,
`components/plugin/layoutfuzz.test.tsx` (300 seeds × 12 steps by default; `FUZZ_SEEDS`,
`FUZZ_STEPS`, `FUZZ_SEED`, `FUZZ_START`), `layoutprobe.test.tsx` (one probe per finding,
named by its id; no `it.fails` is left), `e2e/plugins-layout-fuzz.spec.ts` (WebKit, no
`test.fail` is left) and the mock's fuzz controls (`view:<json>`, `__viewdelay`,
`__actdelay`, `__failnext`: `mock/plugins.ts` fuzzControl).

## Findings

| Id | Root cause | Fix | Status |
|---|---|---|---|
| virt-1 | `VirtualStack` took the nearest `[data-scroll-root]`; a sized pane that scrolls carried no marker, so a long list in it virtualized against the surface's scroll area and never drew past its first screen | `VirtualScrollRoot` context (`components/pr/virtualRoot.ts`): the surface frame, a scrolling sized pane and the wide master-detail's sides provide their element; the DOM lookup stays for the PR views | fixed |
| virt-2 | The wide detail side scrolled on its own but was not a root | The same context (both wide sides provide it) | fixed |
| md-3 / tabs-1, live 1 | The optimistic choice was `pending[watchKey][key]`, cleared when the act answered; the daemon delivers the view up to 100 ms later (`DefaultCoalesce`, `internal/store/plugin/surface.go`, unchanged), so the old row, tab or list flashed back | `chooseElement` and `choices` in `stores/pluginSurfaces.ts` (the rule below) | fixed |
| md-1 | A failure closed the narrow detail whatever was chosen since | Each choice has a sequence number; the answer of a superseded choice changes nothing | fixed |
| md-2, live 2 | `rows.find(pending)` showed the list's first pending row | One choice per chooser, the latest | fixed |
| md-4 | The narrow list remounts at the top after Back, and the virtualizer scrolled its element back to its first offset (0) when it first observed it, so the row was never drawn | `VirtualStack` starts the virtualizer at the root's offset (`initialOffset`) and takes a `reveal` (scroll the item's estimated place into view, hand the virtualizer the offset, give the item's element over in the commit that draws it; given up after two frames); the master-detail reveals and focuses the row whose detail it was | fixed |
| md-6 | The owed focus was retried on every render until a target showed up | Back's focus: one try, in the commit after the choice; the row's: the reveal (two frames at most); neither moves focus that is elsewhere (`focusFree`) | fixed |
| md-7, live 4 | Nothing took focus when a refused choice closed the detail | Any narrow detail → list change with focus lost reveals and focuses the row whose detail it was (Back, a refusal, the plugin moving on) | fixed |
| fill-1 | `useNodeHeight` measured on mount and on the box's resize; a scroll area does not resize when its content does | A `MutationObserver` over the box (records outside the node itself) re-measures; its callback runs before the next paint | fixed |
| fill-3 | The box's resize callback measured before the columns re-rendered side by side | The mutation from that re-render re-measures, and the box's resize measures again a frame later | fixed |
| fill-2 | `fillBoxOf` ran once per effect and nothing changed when an enclosing pane became a box | `FillBoxContext`: a sized pane provides itself, the surface frame its scroll area; the providers are always there (an auto pane passes the outer value), so a height change re-measures without a remount | fixed |
| group-1 | Progress items were `shrink-0` with a 160 px basis, so `noWrap` overflowed | Under `noWrap` they shrink (`shrink`, basis 160 kept) | fixed |
| tabs-2 | The strip measured on its own resize and `items.length` only | It also measures when a label or badge changes (`shape`) | fixed |
| tabs-3 | The active tab was scrolled into view before the "earlier tabs" chevron took 20 px | The active tab is brought into view again when the chevrons come or go, unless the user scrolled the strip since (scroll events we cause are told apart from the user's) | fixed |
| scope-1 | `collapsed` was per instance and section key | Keyed by `draftKeyOf(instance, scope, key)`, like drafts (per view tab, node tab, selected row) | fixed |
| strip-flex | The spacer and a form were both `flex-1` | Beside a form, a progress bar or a growing group the spacer is `grow-[0.001] basis-0` (the sum of grows stays over 1, so the free width is all taken); alone it is `flex-1` | fixed |
| render-1 | `NodeView` was not memoized; a new view was all new objects; `ViewCtx` changed with every version | `memo(NodeView)`; `shareView` keeps the objects of unchanged nodes (deep equality by key, at any depth); `ViewCtx` has no version (nothing read it) | fixed |
| render-2 | An inline callback ref on the master-detail: detach and re-attach, two renders a pass | Stable callback refs (also on `PaneNode`) | fixed |
| docs-1 | `primitives.md` listed four container kinds | All seven, pointing at `ui-layout.md` | fixed |
| harden-1 | Nested interactive rows; no keyboard tabs pattern; store maps grow | Tabs: live 5. Rows with buttons inside a `role="button"` row and the growth of `drafts`, `resetTokens`, `details` and `collapsed` for the GUI's life | **left** (not cheap: the row needs a stretched-target restructure that moves the row's test id and focus; the growth is one small entry per form, row and node tab seen) |
| live 5 | Tabs had no keyboard model; WebKit skips buttons on Tab unless they carry an explicit `tabindex` | `TabStrip`: one roving tab stop (`tabIndex` 0/−1), ArrowLeft/Right (wrapping), Home, End move focus, Enter/Space choose (manual activation: a choice is an act); ids, `aria-controls`, the tabs node's panel `aria-labelledby`; Back has an explicit `tabIndex` | fixed |
| live 6 | Toggle semantics on chosen rows; unlabelled sides and strips | Master-detail rows `aria-current` (no `aria-pressed`), the node a `group`, each side a labelled `region` (the detail named by its row); the toolbar and footer labelled regions. `listbox`/`option` not adopted: rows can hold buttons, which options cannot | fixed (rows' nesting: harden-1) |
| live 7 | `overscroll-contain` on both wide sides trapped the wheel | Removed: at its end a side hands the wheel on to the body | fixed |
| live 8 | The inline budget ignores the app's stream slots; Attach could pause the one node that streamed | No Attach (and its sentence says why) while any stream waits for a connection; documented in `ui-layout.md` and `primitives.md` | fixed |
| live 9 | A log is `rows` lines tall whatever its pane | A log that is a sized pane's only node shrinks to the pane (down to 4 lines), so its tail shows; beside other nodes it keeps its rows (documented) | fixed |
| live 10 | Tabs were `shrink-0` with no cap | `max-w-[min(16rem,80%)]`, the label truncated, the whole label in a `Tip whenTruncated`. No SDK change: `MaxTabTitle` (40) stays | fixed |

## The choice rule (view tabs, node tabs, master-detail rows)

One rule, `chooseElement(watchKey, chooser, key)`:

* The chooser's key is `draftKeyOf(instance, scope, node key)` (the view's tabs:
  `draftKeyOf(instance, "", "")`); a master-detail's is also its narrow state's key.
* From the click the choice reads as chosen (the tab active, the row selected, the old
  detail or tab dimmed and its live nodes let go).
* After the act's answer it ends with the first view that **shows it** (or no longer
  shows its chooser), at most `CHOICE_HOLD_MS` (5 s) after the answer. A view that does
  not show it does not end it: one sent before the act can still arrive after the answer
  (coalescing, and the act and the watch are separate requests). This is stricter than
  "the first view newer than the acted version", which flashed the old selection in the
  e2e thrash with `__viewdelay`.
* Ending reconciles: a narrow master-detail whose view selects another row goes back to
  the list (a plugin that takes the act and does nothing, or answers late and moves on).
  So a `noop` plugin shows the dimmed choice for 5 s, then its own selection.
* A failure (still the latest choice) drops it at once; the master-detail closes its
  narrow detail. A later choice on the same chooser replaces an earlier one, whose answer
  then changes nothing.

`pending[watchKey][key]` stays for what it was before: an element's act in flight
(buttons' spinners, a form's lock).

## Renders (render-1)

Every node kind's renders for one update of a 16-node view (a master-detail with its
detail's text, a log, a text, columns holding a grid of ten texts), counted by wrapping the
renderers table (`layoutprobe.test.tsx`):

| Update | Before | After |
|---|---|---|
| A log append | 16 | 1 |
| The next view (the log's lines change back) | 16 | 1 |
| An equal view | 16 | 0 |
| A view changing one text | 16 | 1 |

## Gotchas

* TanStack Virtual caches its scroll offset at the first `getScrollOffset` (in render) and
  scrolls its element to it when it first observes the element, so a list that mounted
  into an already scrolled area jumped it to the top. `initialOffset` reads the root's
  `scrollTop`; a reveal sets `v.scrollOffset` and calls `v.measure()` so the re-render
  draws the item before the paint (its own scroll events come a frame later).
* WebKit does not focus a clicked button: the nearest focusable box (the side panel's
  `aside`, `tabindex=-1`) takes focus. "Focus lost" is therefore body, nothing, or a box
  around the node.
* WebKit's default Tab mode skips `<button>` unless it has an explicit `tabindex`
  (checked on a bare page: plain button skipped, `tabindex=0` reached).
* The fill re-measure probe awaits a microtask (`MutationObserver`).

## Left

* harden-1's nested interactive rows and store growth (above).
* Live 3 (`keptVersions`, the raw "version … is gone" toast), live 11 (act timeout as
  HTTP 500) and live 12 (the depth error's wording) are daemon and SDK work for the other
  PR.

## Verification

`make check` green. WebKit: `e2e/plugins.spec.ts` and `e2e/plugins-layout-fuzz.spec.ts`
(18 tests: the 15 of the fuzz pass, all plain checks now, plus live 5, 7 and 9).
Screenshots (mock, WebKit, dark and light) are in the PR body.
