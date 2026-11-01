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
  (`[data-slot=ti-row]`) when the menu opens and passes `alignOffset` (row left minus
  button left), `sideOffset` (row bottom minus button bottom, plus 4) and the row's width
  as `--ti-row-width`. The button is centred in its row, so a flip above the row is placed
  right too.
* **The row keeps its hover tint while its ellipsis menu is up**
  (`has-[[data-row-more][aria-expanded=true]]`), as a trigger row does with its own menu.
* **Ellipsis button**: `RowMoreButton`, the chevron's `size-4` box so the glyphs line up,
  muted, `hover:bg-cf-text/10` and the same on `aria-expanded`, `rounded-sm` (one step in
  from the row's `rounded-md`). Its hit area is a row tall and 4px wider each side (an
  `after:` overlay). An `aria-label` ("<row> options"), no tooltip.
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

## Tests

* `src/components/threadinfo/Row.test.tsx`: chevron boxes only for "closed"/"open" and
  nothing after the value without one; click, Enter, Space activate and a double click's
  second does not; a menu trigger row never activates; `RowMore` is a labelled, tabbable
  last child; its button and a picked item never run the row's click.
* `e2e/thread-info.spec.ts`: a new split-rows test over the single scenario: no chevron on
  Open in, Actions, PRs, Context, branch and the Lineage label; the right edges of the
  Context and branch values, the four ellipses and the Project, Previous agents, MCP and
  Usage chevrons all within 1px of the row's padding edge; the ellipsis box equals the
  chevron box; each ellipsis menu under its row at its width; the Open in row stays tinted
  while its menu is up; a menu item does not reveal; click and Enter on the row reveal;
  Tab reaches the ellipsis and its Enter opens the menu; the action and PR menus run and
  open nothing. The MCP test now opens the menu from the value, the text, the chevron,
  Enter and ArrowDown, checks the item order and opens the tab through Open MCP panel.
* `e2e/actions.spec.ts` opens the card's action menu through `ti-action-more`;
  `e2e/mcp-panel.spec.ts` opens the MCP tab through the row's menu.
