# Shell 25j: a click anywhere on a rail opens the pane

A user expected a click on a rail to open its pane; only a click on an icon or on Open pane did, and
the rail's empty area did nothing. Now a click anywhere on a rail that is not one of its controls
opens the pane on its selected tab. `shell-model.md` ("Small windows", "Collapsing a pane") says so.

## Decisions

- **One rule for every rail.** A pane the user collapsed opens as its Open pane button does
  (`openPane`: `pane.collapse --off`, then the keyboard to the pane that has the focus). A pane folded
  for lack of room opens as a click on its selected icon does (`focusTabNow(active)` and the
  keyboard to the pane), so it unfolds and another pane may fold. The handler is `openRail` in
  `components/shell/PaneRail.tsx`, on the rail's `<section>`.
- **What is not the empty area.** Anything inside a `<button>` (the icons, Open pane, Full screen)
  keeps its own click; the icons still open on their tab. A click that reaches the section through
  React from a portal (an item of an icon's context menu) is not on the rail: the handler checks
  `currentTarget.contains(target)`, since React bubbles portal events through the component tree.
- **Drags.** The empty area is not a drag source (only the icons are, through `useTabDrag`; a pane
  drags only by its strip). After a dnd-kit drag activates, dnd-kit swallows the next click at the
  document's capture phase (its `PointerSensor`), so a tab drag that ends on the rail never reads as
  a click, and the same would hold if the empty area became a drag source. A drop on a rail is
  unchanged.
- **The tint.** The tablist now fills the rail in both orientations and takes
  `group-hover/rail:bg-cf-control-hover/40`, so the whole rail tints under the pointer; the
  selected icon goes from `cf-control-hover` to `cf-control-active` while the rail is hovered, so it
  stays apart from the tint (the sketch's selected icon darkens the same way). Theme tokens only, no
  animation. Filling the rail moved a vertical rail's icons 1px, to its centre.
- **Keyboard and a11y unchanged.** The section gets no role and no tabindex: the tablist's icons are
  its only tabs, one in the tab order, and Enter on the selected icon or cmd+shift+m open a collapsed
  rail as before. The click on the section is a pointer convenience over controls the keyboard
  already reaches.

## Tests

- vitest `components/shell/PaneRail.click.test.tsx`: the empty area of a collapsed and a folded
  rail and strip runs the right verb, an icon opens on its own tab, Open pane and Full screen do
  what they did, a context menu item is not a rail click, no added role or tab stop.
- e2e `e2e/shell-rail-click.spec.ts`: a real pointer on the empty part of a collapsed rail in a row,
  a collapsed strip in a column and a folded rail opens the pane; a tab dragged out of a collapsed
  rail moves and the rail stays collapsed. Both click tests fail on the old rail.
