# Settings sheet: Settings and Themes in one modal (2026-10-27)

PR 2 of the global-modals series (1 was the shared backdrop, `modal-backdrop.md`; 3 does
the same for Usage). Settings used to replace the content pane. A user found that
confusing: it was not clear how to get back, and the × was small and far from the gear
that opened it. Now Settings is an app-level modal sheet over the dimmed, blurred window,
and Themes shows inside the same sheet. Frontend only.

## What changed

- **`DialogContent size="sheet"`** (`components/ui/dialog.tsx`). Centred
  (`top-1/2 left-1/2`, translated back by half), `w-[min(1280px,calc(100vw/var(--cf-zoom)-96px))]`,
  `h-[min(800px,calc(100vh/var(--cf-zoom)-96px))]`: at most 1280×800 and never closer than
  48px to a window edge, so below 1376×896 it shrinks with the window. The viewport units
  divide by `--cf-zoom` like the default size's `top-[calc(14vh/…)]`. The px values zoom
  with the page, so the margin is 48 layout px (53 viewport px at 110%). It is a clipping
  flex column; the body lays out its own scrolling. `size="default"` is the old geometry.
  Usage (PR 3) only needs `size="sheet"` and `SheetHeader`.
- **`SheetHeader`** (`components/window/SheetHeader.tsx`): the pane header's 44px and
  divider, without PaneHeader's window dragging and traffic-light gutter.
- **`SettingsSheet`** (`components/settings/SettingsSheet.tsx`), mounted in `App.tsx`
  next to the other dialogs. Open while `settingsOpen || themesOpen` (`selectSheetOpen`).
  It shows `SettingsPage` or `ThemesPage`. Settings → Choose… → Themes and back swaps the
  body inside the one open dialog (no close and reopen, the same rect). During the
  close fade it keeps the body it last showed. The content pane renders only Usage or
  the selection now. The settings and themes branches in `App.tsx` are gone.
- `stores/views.ts` is still the source of truth. Every entry point is unchanged:
  `showView("settings")`, `openSettingsPage`, Ember's page, notify links, `theme.pick`,
  `theme.edit`, the palette, cmd+,.
- **Gear:** pressed while the sheet is open, whichever body it shows. The backdrop covers
  the gear, so clicking it is a backdrop click and closes the sheet. That keeps it a
  toggle. cmd+, (`toggleView("settings")`) closes the sheet when it shows either body.
  `view.settings` joined `fieldYielded` in `keys/bindings.ts`, so cmd+, also works from
  the settings search, which has focus as soon as the sheet opens.

## Closing

| Gesture | Settings shown | Themes shown |
| --- | --- | --- |
| × | closes the sheet | `closeThemes`: back to Settings (on the page it came from, Appearance) when opened from there, else closes |
| Escape | closes (after clearing a search) | `themesEscape`: colour view → editor → like × |
| Backdrop, gear, cmd+, | `closeSheet`: closes the whole sheet | same, Themes does not go back to Settings |
| view.back (cmd+[) | closes | like × |

Unsaved edits in the Themes editor still ask first ("Discard changes?") on every path.
The confirm dialog stacks over the sheet.

## selectPageOpen and the panels

The sheet is a modal over the window. The window stays laid out under it, dimmed and
blurred, so the sheet no longer counts as a page covering the content area:

- `selectPageOpen` is now `usageOpen` only. The side panel, the bottom panel and the
  thread under the sheet stay mounted and visible (and keep their streams, since they
  are on screen). Before, Settings hid both panels.
- The panel commands (`view.panel.*`, `view.bottom.toggle`) are no longer no-ops while
  Settings is up. They act on the panels under the backdrop, as they already did under
  help and the palette. Any focus they ask for is held back by the sheet's focus trap,
  so the keyboard stays in the sheet. Mouse use of anything under it is blocked by the
  overlay anyway.
- `bottomActions.uncoverBottom` still closes Settings and Themes, along with Usage. A
  shell this window started for the selection (cmd+t, cmd+j on an empty panel, Run in
  terminal, focusTerminal) takes the keyboard, and it could not do that under a modal.
- `startViewSync` still closes the sheet when the selection changes. The sidebar sits
  under the backdrop, so only the keyboard (cmd+shift+[ ]), the palette or the CLI can
  change the selection.

## Escape

`useEscapeCloses` assumed its page was not inside a `[role="dialog"]`. The sheet does not
use it. It uses Radix's `onEscapeKeyDown`, which only reaches the topmost layer, so a
dialog, select, menu, popover, tooltip or the palette over the sheet takes its own Escape
and the sheet stays. The handler always calls `preventDefault` (Radix never dismisses the
sheet on its own) and decides:

- **Key recorder** (`[data-key-recorder]`): left alone. The recorder records Escape as a
  cancel.
- **Fields** (input, textarea, select, contenteditable, `[role=combobox]`): left alone.
  A text setting reverts, and a closed select's trigger keeps its Escape, as the page
  did before.
- **Empty search:** counts as no field and closes. A search with text clears it in its
  own `onKeyDown`, which runs after Radix's capture listener. `ThemesPage`'s Escape case
  moved from its section handler to its search input, because the section handler
  returns on a prevented event.
- **Otherwise:** `closeSettings` or `themesEscape`.

The hook stays for the Usage page only, until PR 3. Its comment says so.

## Focus

- **On open:** `onOpenAutoFocus` focuses the body's `[data-sheet-focus]` (the settings
  search, the themes list) and not Radix's first tabbable, which on Themes would be the
  ×. A body swapped in while the sheet is open focuses itself through its own effect.
- **On close:** with a thread selected, `onCloseAutoFocus` is prevented and
  `closeSettings` / `closeThemes` / `closeSheet` ask for the prompt
  (`requestPromptFocus`), as before. Elsewhere Radix returns focus to what had it before
  the sheet opened (the gear, a list).

## Toasts over a modal

A modal Radix dialog puts `pointer-events: none` on `<body>`. That reached the toaster
too, so a toast's button (a theme card's Undo, "Show in Settings") could not be clicked
while Settings was up. It had always been the case under help and the palette, but it
matters now that Settings is a modal. `index.css` gives visible toasts
`pointer-events: auto`. The sheet's `onInteractOutside` ignores clicks inside
`[data-sonner-toaster]`, so clicking a toast does not close the sheet. That changes
`index.css`, so the page library's `ui.css` was rebuilt (`make pagelib`), along with
`ui.js` for the dialog change.

## Tests

- `e2e/settings-sheet.spec.ts`:
  - size at 1440×900 (the cap, centred), 1280×800 and 1000×700 (margin-limited), and
    under 110% zoom;
  - gear, Escape, backdrop, × and cmd+, closing, with the prompt refocused;
  - a `settings:memory` link opening the sheet on Memory, and a toast clicked over the
    open sheet;
  - Escape in a select, the palette, the key recorder and help leaving the sheet open;
  - Themes inside the sheet: same rect, one dialog, back to Appearance by Escape and ×,
    backdrop closing everything, `theme.pick` alone closing on Escape;
  - the editor's Save… and Discard dialogs stacking over the sheet;
  - the editor fitting a 900×600 window.
- Updated specs: things under the backdrop can no longer be clicked. `settings.spec`
  (ShowView) and `theme-editor-fuzz` 14 change the selection through `thread.next`.
  `usage-page.spec` replaces Settings through the CLI's `view.usage`. `buttons.spec`
  clicks the gear's position. `panel.spec` and `bottom-panel.spec` now expect the panels
  to stay under the sheet. `layout.spec` checks that the sheet header is 44px and does
  not drag. In `theme-editor-fuzz` 2, the list at 1440 stays full, because the sheet's
  1280 is wider than the old content pane.
- Unit tests: panel and bottom no-op cases moved from `settingsOpen` to `usageOpen`, plus
  cases that the sheet does not block the panel toggle, for `closeSheet`, for
  `themesEscape`, and for cmd+, from a field.

## Gotchas

- Radix's Escape listener is a capture listener on `document`, so it runs before any
  React `onKeyDown` in the sheet. A body that wants Escape first has to be a Radix layer,
  or the sheet's handler has to leave its target alone (the field rule).
- Playwright cannot click things under the backdrop (it reports that the overlay
  intercepts). Use `page.mouse.click` at the element's position when the test means
  "click there, which hits the backdrop".
- Headless WebKit does not paint `backdrop-filter`, so the PR's blur screenshot comes
  from the real app (`modal-backdrop.md`).
