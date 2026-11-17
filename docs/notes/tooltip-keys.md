# Keys in three tooltips

The sidebar footer's Command Palette and Settings buttons and the top bar's sidebar toggle now
name their key after their name, as plain text: "Command Palette ⌘K", "Settings ⌘,",
"Toggle sidebar ⌘B". A user learns the keys from the controls they already hover. The pane
strip's Collapse pane control already did this (`PaneCollapseButton.tsx` `useNamed`); these
follow it exactly.

## Decisions

- **Plain text, no key chip.** A `Kbd` inside the tooltip was rejected as a box inside a box.
  The chord is `formatChord`'s glyphs after a space.
- **Opt-in, not every `CommandButton`.** `CommandButton` takes `withKey`; without it a tooltip is
  the name alone, and chords stay in the palette and help. Only the palette and Settings buttons
  set it. Usage and Help stay as they were (Help has a key, and still shows none).
- **Where each key comes from.** The keys live in two places, and each tooltip reads the one
  that runs it:
  - Settings: `view.settings`'s first registry keybinding (`useCommandChord`). A user can rebind
    or unbind it in settings, and the tooltip follows: another chord, or the name alone.
  - Command Palette: `ui.palette.open` has no keybinding (`NoKeybinding`); cmd+k is a GUI view
    action (`viewActions` in `keys/bindings.ts`) that opens the palette locally. That view
    action now says which command it stands in for (`command: "ui.palette.open"`), and
    `withKey` falls back to it when the command has no chord of its own.
  - Toggle sidebar: no registry command at all; cmd+b is the view action that runs
    `toggleSidebar`, the same function the button runs. `viewActionChord(toggleSidebar)` reads it.
- **cmd+k and cmd+b cannot be rebound today.** They are reserved chords
  (`internal/command/chord.go` `ReservedChords`), so "follows a rebind" only applies to
  Settings. The palette and sidebar tooltips still read the chord from `viewActions` rather
  than spelling "⌘K"/"⌘B" in the component, so if a view action ever moves or goes, the
  tooltip follows; with no chord the tooltip is the name alone.
- **The accessible name stays the name.** `aria-label` is "Settings", not "Settings ⌘,": the key
  is in the tooltip only.

## Tests

vitest only: `SidebarStatus.test.tsx` (palette and Settings with their default keys, Settings
rebound and unbound, the palette with no view action chord, Usage and Help without keys),
`TopBar.test.tsx` (the toggle with and without cmd+b), `CommandButton.test.tsx` (`withKey`
reads the first keybinding, then the stand-in view action, then nothing). The "no key" cases
for the two view actions replace `viewActionChord` in the module mock, since nothing in the
app can unbind them.

## Gotchas

- Screenshots of a tooltip after another one: Radix keeps the closed tooltip in the DOM during
  its fade-out, so `getByRole("tooltip")` matches two. Filter on
  `[data-slot="tooltip-content"]:not([data-state="closed"])`, or reload between shots.
