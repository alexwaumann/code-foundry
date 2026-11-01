# Thread info card: a gear on the Actions menu's items

Status: done on branch `cf/thread-info-action-menu-gear` (GUI only). A user asked for a way
to edit an action from the card's Actions menu (the ellipsis on the action row) without
going to the project page. Each action item gets a gear at its right end that opens the
action editor for that action; the item hovers as two blocks, like the card's split rows
(docs/notes/thread-info-split-hover.md).

## The rule

* **The gear shows on the highlighted item only** (Radix's `data-highlighted`, pointer or
  keyboard) and while it has focus. It is rendered, transparent (`opacity-0`), in every
  item, so nothing shifts and it stays focusable.
* **Geometry.** The item keeps shadcn's `px-2 py-1.5 rounded-md`. The gear is a 16px box
  (`size-4`, glyph `size-3.5`, lucide `Settings`) at the item's right padding, on the same
  8px line as the text's left padding. Its block is the gear's `after:`: the item's last
  32px at its full height, `rounded-r-md`, so the tint is centred on the glyph. The item's
  left block is its `before:`, from its left edge to 34px short of its right (the 32px block
  plus the 2px seam), `rounded-l-md`. The card's rows use a 24px block for their 16px
  ellipsis; the menu item's padding is 8px rather than the row's 4px, hence 32.
* **Tints**, as on the card's rows: the block under the pointer is `bg-cf-control-hover`, the
  other at half strength. Text hovered or the item highlighted from the keyboard: left
  bright, gear dim. Gear hovered or focused: gear bright, left dim. The glyph is
  `text-cf-text` while its block is bright, muted otherwise. The item has no tint of its own.
* **Clicks.** The item (click, Enter, Space) runs the action, as before. The gear (click,
  Enter, Space) opens the editor in edit mode (`openActionEditor({ mode: "edit", actionId,
  projectId, from: "thread" })`, the project page's call), closes the menu, and runs nothing.
* **Keyboard.** ArrowUp/Down move the highlight. ArrowRight on an item focuses its gear;
  ArrowLeft on the gear gives focus back to the item; ArrowUp/Down on the gear focus the item
  and move on from it. The gear is `tabIndex={-1}` (the menu's roving focus is unchanged),
  `aria-label="Edit action"`, no tooltip. Escape closes the menu as before.
* Unchanged: Add action (and its project submenu), the "Add an action to" label, project
  group labels, the header's and the project page's action menus.

## Decisions

* **A component of its own**, `GearMenuItem` in `components/threadinfo/GearMenuItem.tsx`,
  over `DropdownMenuItem` (shadcn first), with its classes as `GEAR_ITEM` / `GEAR_BUTTON`.
  `ActionItem` in PlaceGroup.tsx passes `onRun` and `onGear`. The card rows' `SPLIT_ROW`
  classes are not shared: the selectors differ (`data-highlighted` instead of hover/focus,
  no menu-open state), and sharing them would have meant touching the rows.
* **The left block lights on `data-highlighted`**, not hover: Radix focuses the item under
  the pointer (pointermove), so pointer and keyboard are one state. The dim left block is
  `has-[[data-action-gear]:hover]` / `has-[[data-action-gear]:focus-visible]`, whose `:has()`
  outranks `[data-highlighted]`.
* **One select path for both targets.** The item records on its `onClick` whether the click
  came from inside `[data-action-gear]`, and `onSelect` calls `onGear` or `onRun`. Radix then
  closes the menu the same way for both, with no state passed down from RowMore.
* shadcn's `focus:bg-accent` is replaced by `focus:bg-transparent` on these items only (`cn`
  merges the two).

## Gotchas

* **Radix fires an item's `onSelect` for any click inside it.** `MenuItem`'s `onClick` is
  `handleSelect`, and the gear's click bubbles to it. Stopping the gear's click would also
  stop the menu from closing, so the item tells the two apart instead (above). The e2e test
  fails (one run) if the gear also runs the action.
* **Keys on the gear never reach Radix's item handling**: `MenuItem` and the roving focus item
  ignore keydowns whose target is not the item. Enter and Space on the gear are handled by the
  gear (`preventDefault` + `stopPropagation`, then a click on itself, which takes the select
  path above); without `stopPropagation` the content's typeahead sees the Space, and without
  `preventDefault` the button's own activation clicks a second time. ArrowUp/Down focus the
  item and re-dispatch the key on it, so Radix's roving focus (and its looping) moves on;
  the roving focus moves on a timeout, so the unit test waits for it.
* **The menu item's svg rule** (`[&_svg:not([class*='size-'])]:size-4`, and the same for
  `text-`) outranks a `[&_svg]:size-3.5` on the button, so the gear's svg carries
  `size-3.5 text-current` itself.
* **Focusing the gear keeps the item highlighted**: React's `onBlur`/`onFocus` bubble, so the
  item's blur (to its own child) is followed by the child's focus, which sets the item's
  focused state again. The gear stays visible with focus on it, and `focus-visible:opacity-100`
  covers it regardless.
* The menu scales in when it opens: geometry checks in e2e wait for its animations to end.

## Tests

* `GearMenuItem.test.tsx`: a gear in every item, last, a labelled `tabIndex=-1` button,
  transparent unless highlighted; a plain item has none; the item's and gear's block classes
  (34px, 32px, z -1, radii, bright/half rules, no tint of its own); a gear click opens the
  editor, runs nothing and closes the menu; a text click and Enter run; ArrowRight/ArrowLeft
  move focus between item and gear; Enter and Space on the gear edit; ArrowDown on the gear
  moves to the next item.
* `e2e/thread-info.spec.ts` "the action menu": six gears, none on Add action; the gear's
  `::after` 32px by the item's height at its right edge, the `::before` ending 34px short, the
  glyph 16px and 8px from the item's right edge; text hover full/half and the gear visible on
  that item only; gear hover half/full and the bright glyph; ArrowDown highlights the next item
  and shows its gear; ArrowRight focuses it (half/full), ArrowLeft returns; ArrowDown/Up from
  the gear; a gear click opens the editor in edit mode on that action (its name) and no
  `action.run`; Enter on a focused gear the same; a text click runs the action.
* Running the whole thread-info file on one worker, the wheel/overlay tests ("the card lays
  over…", "a wheel over a card shorter…", "a page's Expand…", "the overlay: off at narrow…")
  failed now and then on `data-at-bottom` under load, on main as well; they pass alone.
