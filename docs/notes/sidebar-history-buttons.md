# Sidebar history buttons

Back and Forward (`view.back`, `view.forward`) sit in the sidebar band, on its right edge,
after the app name. `components/sidebar/HistoryButtons.tsx`.

## Decisions

- Right edge, chevrons, 24px boxes around 14px glyphs: the name stays where it was and the
  last glyph lines up with the menu card's edge. Chosen from four real-app sketches over
  buttons before the name, buttons following the name, and 20px buttons (only 10px narrower).
- Tooltips name the command and show no chord (the `CommandButton` rule stands) and float
  down (`tooltipSide="bottom"`): the band is at the window's top.
- `SIDEBAR_MIN` and `SIDEBAR_DEFAULT` rise from 220 to 260. At 90% zoom, the widest gutter in
  layout px, the band needs 89 + 12 + 107 + 43 = 251, leaving a 9px gap (7px measured,
  with the name's real width and rounding). 250 would clip the name there. Saved widths under
  260 are clamped up on load, so no migration.
- `windowMinWidth` rises from 900 to 940 so the side panel still fits at the smallest window:
  260 + 3 x 12 + 360 + 280 = 936. At 900 `panelMax` drops below `PANEL_MIN` and it would hide.

## Dimming

Each button dims when it would do nothing. `canStepHistory` (stores/ui.ts) prunes a copy of
history the way `stepHistory` does. Back also stays lit while Settings, Themes or Usage is up
(`selectAnyViewOpen`), since `historyCommand` closes those first; Forward does not.

`CommandButton` gained `disabled` (a listed command that would do nothing) and `tooltipSide`.
A disabled one is wrapped in a span so its tooltip still opens.

## Gotchas

- The band drags the window, so the buttons set `--wails-draggable: no-drag`.
- The Forward box overhangs the sidebar by 5px, as the status row's last button does, and the
  resize handle owns that strip: the right 5px of the box resizes instead of clicking.
- `canStepHistory` runs in a ui store selector, so a thread removed elsewhere leaves Back lit
  until the ui store next changes. Pressing it then prunes the entry and dims it.
- The sidebar's extra 40px comes out of the content pane, so e2e tests with hard-coded room
  bounds or a window size picked for a content width moved with it.

## Checked live

In the built Wails window with real mouse events: Back and Forward step and dim, the tooltips
float down, a drag from the band moves the window, a drag started on a button does not, and the
window stops at 940 with sidebar, content and side panel all showing.
