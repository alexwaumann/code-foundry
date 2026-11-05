# Terminal find (cmd+f in a terminal)

Terminals get the thread's find bar: query, "Aa" under smart case, "4 of 9", previous, next,
close, floating at the terminal's top right. A user asked for it.

## Layout

- `components/find/FindBarView.tsx`: the presentational bar both finds share, extracted from
  the thread's. `components/thread/find/FindBar.tsx` and
  `components/terminal/TerminalFindBar.tsx` own the state, where it sits and when the field
  takes the keyboard. The thread bar's test ids, behaviour and tests did not change.
- `terminal/find.ts` (`TerminalFind`): @xterm/addon-search 0.16.0, the release for xterm
  6.0.0. It sits behind `TerminalRenderer` (`find`, `findStep`, `clearFind`,
  `onFindResults`), so `TerminalHost` never touches xterm.
- `stores/terminalFind.ts`: one session per terminal id, holding the query and the last
  results. The matches themselves live in the renderer.
- The bar renders in `TerminalHost`, so a plugin's `TerminalNode` has it too. It is outside
  `[data-terminal-host]` on purpose: that attribute makes the keymap treat a target as the
  shell. `[data-terminal-box]` on the wrapper covers xterm and the bar, and says which
  terminal has the keyboard.

## Chords: one chord, two commands

`terminal.find`, `.next` and `.previous` declare the same chords as `thread.find` and its
two siblings (`command.SharedChords` is the one allowed exception to unique chords).
`commandBindings` skips them, so outside a terminal nothing changes. With the target in
`[data-terminal-host]`, `terminalCommand(chord)` looks first.

- It resolves from the DOM at the key press, not from availability. The list can be a
  debounce behind a focus change, and a plugin's terminal is in no daemon context.
  `available` only decides the palette.
- Rebinding: each command has its own chords. Move `terminal.find` away and cmd+f in a
  terminal is `thread.find` again, as before this change. Move `thread.find` away and cmd+f
  is the terminal's alone.
- A rebound chord may use ctrl or alt, not only cmd: binding ctrl+f to terminal.find means
  it, so it beats the program. A bare key never does.
- In the bar's field the chords are the bar's, as in the thread's. Other command chords
  (cmd+j, cmd+t) do nothing there, like every text field (`fieldYields`); cmd+w still closes
  the tab because the panel takes it in the capture phase.

## What the addon does that matters

- **It keeps its position in the terminal's selection.** So the current match is selected,
  and a selected cell takes the selection's colours over a decoration's, in both renderers.
  While there is a query the theme's selection colours are the current match's
  (`XtermRenderer.applyTheme`). A mouse selection made meanwhile has that colour too, and
  clicking in the terminal drops the position: the next step starts from the top.
- **Decorations need opaque #RRGGBB.** `findColors` flattens `--cf-warning` over
  `--cf-surface`. Text keeps its colour, so the current tint backs off until the foreground
  keeps 4.5:1, or 80% of what it has on the surface where that is less (Solarized). Every
  match is at most half the current tint, or muted themes would make the two equal.
  `theme.test.ts` checks every catalog theme.
- **Decorations keep their colours.** On a theme change everything is searched again;
  `watchTerminalTheme` also watches `--cf-warning`, which is not in the palette.
- **It searches again only after 200 ms of quiet.** A build log never gives it that, so
  `TerminalFind` forces a search when the count is a second old, or ten searches' time.
- **`highlightLimit` cuts from the top of the buffer**, so past it the newest matches are the
  unhighlighted ones. 20,000 (VS Code's number) keeps that to one or two letter queries in a
  full scrollback. Measured in WebKit on 10,000 lines: 65 ms for 5,000 matches, 260 ms for
  20,000. The count then says `20000+`, or `4 of 20000+`. A flood at full scrollback with
  20,000 matches parsed about 3,000 lines in 1 to 2 s, because each marker hears each trim.
  Only with the bar open on such a query.
- `clearDecorations(true)` and `findPrevious`'s `noScroll` are not in the addon's typings.
  The pin is exact; check `AddonInternals` when bumping it.

## Reattach, tabs, panel

One `TerminalHost` serves every tab of a panel, so a tab switch resets the same renderer.
`reset()` drops the matches at once and keeps the addon's query, which re-searches once the
snapshot is parsed. The host's effect, after the attach effect, then sets that tab's query
or clears. After a reconnect the current match is the newest again: the selection went with
the buffer. Results always publish (the store drops duplicates), or a tab coming back to no
matches would keep its old count.

Hiding the panel unmounts the host: renderer, addon and decorations go, the Attach stream
ends, the query stays. It comes back highlighted without taking the keyboard, which is why
the bar compares `focusSeq` with `focusedSeq` instead of focusing on mount. A session goes
when its terminal leaves the terminals store. An exited terminal is searchable: the find
only reads the buffer.

## Alternate screen

In vim or less the find sees only the screen: the addon searches the active buffer, and the
alternate one has no scrollback. Leaving the screen searches the scrollback again. xterm
hides decoration elements there, so the current match has no outline, only its tint.

## Palette

The palette hands the keyboard back to the terminal as it closes (`bottomFocusSeq`), after
the bar's effect would have run, so a find picked there waits for it (`afterPalette`). With
the keyboard in no terminal the presenter takes the last one that had it, else one on screen:
that also serves the CLI's ShowView.

## Tests

vitest: `terminal/find.test.ts` (real xterm and addon: counts, steps, reset, alternate screen,
limit), `terminal/theme.test.ts`, `stores/terminalFind.test.ts`, `keys/bindings.test.ts`
(routing, rebinds), `components/terminal/TerminalFindBar.test.tsx`. e2e:
`e2e/terminal-find.spec.ts` and one test in `plugin-owned.spec.ts`. The mock has
`POST /__mock/terminal/print`.

jsdom needs a `matchMedia` stub to open xterm, and the addon cannot select before `open()`.
The mock's prompt has `fix-resize` in its path, so specs search for another word.

Checked by hand against a real daemon: a zsh shell, `cat`, vim, and
`code-foundry terminal find.next` reaching the window.

The daemon needs a restart to list the three commands. Until then cmd+f in a terminal is
`thread.find`, as before.
