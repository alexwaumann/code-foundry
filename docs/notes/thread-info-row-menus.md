# Thread info card: row menus

Status: done on branch `cf/thread-info-row-menus` (GUI only). The card's `Row` had one mark,
the chevron, meaning three things: the whole row opens a menu (Project), the row folds
(Shells, Changes over several projects, Usage, Previous agents), or only the chevron opens
a menu while the rest of the row does something else (`menuOnChevron`: Open in Finder,
Actions, a pull request; MCP also had `menuOnMeta`). Every row reserved a chevron column so
values lined up. A user asked for one meaning per mark; these are the agreed changes.

## Vocabulary

* **Chevron: the whole row is a disclosure.** It opens a menu (the row is the Radix
  trigger) or a fold. Right while closed, down while the menu is up or the fold open.
* **Ellipsis: more options for a row with its own click.** A click (or Enter, Space) on the
  row runs its primary thing; the ellipsis (`RowMore`, passed as `trailing`) is its own
  focusable button that opens the menu.
* **No reserved column.** A row draws the chevron box only when `chevron !== "none"`.
  Without one, its value or trailing button ends at the row's padding (`pr-1`), which is
  where a chevron's box ends: the Context value, the branch value, every ellipsis, every
  chevron, Fix/Resolve/Rebase and the stop squares share one right edge. This overrides
  the v14 sketch's decision (values line up through a column every row reserves),
  overridden by the user on 2026-11-01.

## Rows after

* **Project**: unchanged (whole row, chevron).
* **Open in Finder**: click reveals the cwd; ellipsis "Open in options" (Finder, editors,
  Terminal).
* **Actions** with an action to run: click runs it; ellipsis "Actions options" lists every
  action, then Add action. With no action picked (picks still loading) the whole row is the
  menu trigger and keeps its chevron. "Add action" rows are unchanged.
* **Pull request**: click opens its PR tab; ellipsis "Pull request options" (Open on
  GitHub, Copy URL).
* **MCP**: the whole row is the menu trigger (chevron), like Project. Menu: Open MCP panel
  (lucide Plug, the row's icon; `openMcpSurface()`), Refresh, then a separator and
  Reconnect per failed server. Enter, Space and ArrowDown open it. The attention counts
  stay in the value column.
* **Lineage label**: its ellipsis is the same `RowMore` (it was the model for it): 16px
  box now (was 20px), menu at the row's width (was `align="end"`, `min-w-52`).
* **Folds** (Shells, Changes over several projects, Usage, Previous agents): unchanged.
* **Stop squares** (lineage children, servers) moved from `right-7` to `right-1`: they lay
  over the value, which now ends at the row's padding.

## Removed

* `menuOnChevron` and `menuOnMeta` and the value-plus-chevron trigger zone
  (`ti-mcp-menu-zone`, `data-row-chevron`, the `fromChevron` press filter) from `Row.tsx`.
  The MCP row's click no longer opens the MCP tab; its menu's first item does.
* The reserved chevron column on rows without a chevron.

## Decisions

* **One menu placement for all four ellipsis menus** (Open in, Actions, PR, Lineage): the
  menu sits under the row at the row's width, as a chevron row's does. Radix anchors a
  menu to its trigger, here the 16px button, so `RowMore` measures the button and its row
  (`[data-ti-row]`) when the menu opens and passes `alignOffset` (row left minus button
  left), `sideOffset` (row bottom minus button bottom, plus 4) and the row's width as
  `--ti-row-width`, all divided by the page zoom (see Review fixes). The button is centred
  in its row, so a flip above the row is placed right too.
* ~~**Every row with an ellipsis is tinted while its menu is up**~~ Superseded by the split
  hover (docs/notes/thread-info-split-hover.md): while the menu is up only the ellipsis
  block is lit, the row's own block is not (the Lineage label too).
* **Ellipsis button**: `RowMoreButton`, the chevron's `size-4` box so the glyphs line up.
  An `aria-label` ("<row> options"), no tooltip. ~~Muted, `hover:bg-cf-text/10` and the same
  on `aria-expanded`, `rounded-sm`, a hit area a row tall and 4px wider each side.~~
  Superseded on 2026-11-01 by the split hover: a user asked for it because two distinct
  hover zones make the second target obvious. A row with a `RowMore` lights as two blocks
  with a 2px seam: the row's `before:` (left edge to 26px short of the right, `rounded-l-md`)
  and the button's `after:` (the row's last 24px at its full height, tall PR rows too,
  `rounded-r-md`; it is still the click target). The block under the pointer gets
  `bg-cf-control-hover`, the other the same at half strength; keyboard focus lights only
  its own block; while the menu is up only the ellipsis block is lit. The glyph is
  `text-cf-text` while its block is bright, muted otherwise. Rows without a `RowMore`
  keep the whole-row tint.
* **Usage's fold detail keeps `pr-7`**: Usage still has a chevron, so its value (and the
  fold's cost column under it) stays left of the chevron box. MCP's value lines up with
  Usage's for the same reason.

## Gotchas

* **WebKit leaves plain buttons out of the Tab order** (Safari's default, and the app's
  WKWebView). The rows are tabbable through their explicit `tabIndex={0}`, so the ellipsis
  gets one too; without it Tab skipped from the row to the next row.
* **React bubbles a portalled menu's events to the row it was rendered in.** `RowMore`'s
  content is a React child of the Row, so a click or Enter on a menu item reached the
  row's `onClick`/`onKeyDown` and ran the row's primary action too. The row only activates
  for presses inside its own DOM and not on its `[data-row-more]` button (`ownPress`).
  A Tip wrapped around a row with a `RowMore` would see the menu's pointer events the same
  way; none of today's has one.
* TypeScript narrows `choice` from `const action = choice?.action; if (action)`, so
  `choice?.showProject` inside that branch is an "unnecessary optional chain" to oxlint.

## Review fixes

* **Zoom.** `getBoundingClientRect` is viewport px, but `ui/dropdown-menu` multiplies its
  offsets by the zoom and the popper content zooms back (index.css), so the measured
  offsets and width were scaled twice off 100%. `rowPlace` divides them by `zoomFactor()`.
  Radix's `--radix-dropdown-menu-trigger-width` is viewport px too: `RowMenu` and the card's
  Add project list divide it by `--cf-zoom`, as `ui/select` and FormNode do.
* **The action row across runs.** `useActionPicks` is keyed by the newest run, so after a
  run the picks are null until the new read lands, and the row switched to the "Actions"
  tree and back: a remount (a flash, its focus dropped). ActionRow keeps the last choice
  for the same thread while the picks are null. A run still moves the keyboard to its
  terminal tab (`runAction` focuses the bottom panel by design), so "Enter twice on the
  row" is not a thing; the e2e test checks the row element survives two runs and never
  shows anything but the action's name.
* **Escape gives focus back.** `RowMenu` let no menu return focus (`onCloseAutoFocus`
  prevented), so after Escape Tab started from the top. It now lets Radix focus the
  trigger after an Escape only (the ellipsis button, or the chevron row). Other closes
  keep focus where it went: an item may focus what it opened (a terminal, the Add project
  list, which closes on a focus outside), and a press outside is the reader's.
* **Accessible names.** A row button containing its ellipsis was named "Open in Finder Open
  in options". A row whose `trailing` is a `RowMore` is now `aria-labelledby` its text and
  value spans. Only those rows: labelling every row the same way made
  `plugin-env-restart.spec.ts`'s title menu miss its Escape in 3 of 6 runs (the Project row,
  a Tip-wrapped menu trigger, is in that flow), 0 of 6 without; the cause was not pinned
  down.
* **Chevron on the multi-project "Add action" row**: it is a whole-row menu.
* **Row marker.** `RowMore` finds its row by `data-ti-row`, set after the props spread.
  Moving `data-slot="ti-row"` after the spread instead renamed every Radix trigger row's
  slot, so the marker is its own attribute.
* Left out: a menu open while the window resizes keeps its measured place (accepted).

## Tests

* `src/components/threadinfo/Row.test.tsx`: chevron boxes only for "closed"/"open" and
  nothing after the value without one; click, Enter, Space activate and a double click's
  second does not; a menu trigger row never activates; `RowMore` is a labelled, tabbable
  last child; its button and a picked item never run the row's click.
* `e2e/thread-info.spec.ts`: a new split-rows test over the single scenario: no chevron on
  Open in, Actions, PRs, Context, branch and the Lineage label; the right edges of the
  Context and branch values, the four ellipses and the Project, Previous agents, MCP and
  Usage chevrons all within 1px of the row's padding edge; the ellipsis box equals the
  chevron box; each ellipsis menu under its row at its width; ~~the Open in row stays tinted
  while its menu is up~~ (now the split hover's blocks, see thread-info-split-hover.md); a menu item does not reveal; click and Enter on the row reveal;
  Tab reaches the ellipsis and its Enter opens the menu; the action and PR menus run and
  open nothing. The MCP test now opens the menu from the value, the text, the chevron,
  Enter and ArrowDown, checks the item order and opens the tab through Open MCP panel.
* Review round: the split-rows test also checks Escape returns focus to the ellipsis (then
  Tab reaches the action row) and to the Project row; the row names ("Open in Finder",
  "Open in options", "Dev"); the action row element across two runs; the Lineage label's
  tint (now its blocks). New zoom tests at 90% and 125% check the Open in, Project and PR menus' left edge
  and width against their rows and the PR menu's gap (4px times the zoom). `Row.test.tsx`
  adds the ellipsis row's name, the marker under a wrapper's `data-slot`, and the tint
  class on a non-interactive row. The zoom and action-row assertions fail with their fix
  taken out.
* `e2e/actions.spec.ts` opens the card's action menu through `ti-action-more`;
  `e2e/mcp-panel.spec.ts` opens the MCP tab through the row's menu.
