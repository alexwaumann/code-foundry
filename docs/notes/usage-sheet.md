# Usage sheet: the last content-pane page becomes a modal (2026-10-27)

PR 3 of the global-modals series (1: the shared backdrop, `modal-backdrop.md`; 2: Settings
and Themes in a sheet, `settings-sheet.md`). The Usage page used to replace the content
pane, like Settings did. Now it is a modal sheet over the dimmed, blurred window, the same
size as the settings sheet. After this PR no window-level page replaces the content pane,
so the code that handled one is gone. Frontend only.

## What moved

- **`UsageSheet`** (`components/usage/UsageSheet.tsx`), mounted in `App.tsx` beside
  `SettingsSheet`. `DialogContent size="sheet"` (cap 1280×1280, 48px from every window
  edge, zoom-aware; `settings-sheet.md`). It renders `UsagePage` while `usageOpen` is set.
  `stores/views.ts` stays the source of truth, and `setPages` already keeps `usageOpen`,
  `settingsOpen` and `themesOpen` exclusive, so at most one sheet is up.
- **`UsagePage`**: `PaneHeader` → `SheetHeader`, `h1` → `DialogTitle` (the dialog's
  accessible name is "Usage"). The header keeps the title, "Code Foundry threads only",
  the range control and the ×. The `no-drag` classes went with the window dragging. The
  section is `data-sheet-focus` (was `data-focus-root`) and `outline-none`.
- **Entry points are unchanged:** `view.usage` from the palette, a bound chord or the CLI,
  and the sidebar's chart button (`status-usage`).
- **Chart button:** pressed while the sheet is open. It sits under the backdrop, so a
  click on it is a backdrop click and closes the sheet: still a toggle, like the gear.

## Closing and focus

- Esc, a backdrop click, the ×, the chart button and `view.usage` from this window
  (`toggleView`) close it, all through `closeUsage`. A ShowView from the CLI only shows.
- Escape is Radix's own: the page has no field, so the sheet does not need the settings
  sheet's `onSheetEscape` rules. Radix only sends Escape to the top layer, so the palette,
  help or a tooltip over the sheet takes its own Escape and the sheet stays.
- **On open** `onOpenAutoFocus` focuses the page's section (`[data-sheet-focus]`), not
  Radix's first tabbable (a range button, which would show a focus ring).
- **On close**, with a thread selected, `onCloseAutoFocus` is prevented and `closeUsage`
  asks for the prompt (`requestPromptFocus`), as before. Elsewhere Radix returns focus to
  what had it before the sheet opened.
- A toast's button is not the backdrop (`onInteractOutside`, as in the settings sheet).
- A selection change (cmd+shift+[ ], the palette, the CLI) still closes it
  (`startViewSync`), and `view.back` still closes it first (`historyCommand`).

## Removed as dead

With nothing covering the content pane, "a page is open" is always false:

- **`selectPageOpen`** and `pageOpen()` (`stores/views.ts`). PR 2 had reduced it to
  `usageOpen` only.
- **The `pageOpen()` guards** on `togglePanelCommand`, `expandPanelCommand`,
  `newPanelTabCommand`, `splitPanelCommand`, `worktreePanelCommand`,
  `linkedPrsPanelCommand`, `usagePanelCommand`, `mcpPanelCommand`, `agentsPanelCommand`
  and `threadsPanelCommand`. Under the Usage sheet they now act on the panels under the
  backdrop, as they already did under the settings sheet, help and the palette. The
  sheet's focus trap keeps the keyboard.
- **`bottomVisible`'s `pageOpen` argument** (`stores/bottomPanel.ts`), and with it the
  page checks in `visibleBottomKey`, `bottomCanShow`, `BottomPanel`, and
  `useInVisibleBottom` (`stores/pluginTerminals.ts`). The bottom panel stays mounted under
  the sheet and keeps its Attach stream, since it is still on screen.
- **The page checks in `SidePanel` and `PanelToggle`**: the side panel stays mounted
  under the sheet.
- **`App.tsx`**: the `usageOpen ? <UsagePage /> : <Content />` branch, and
  `!pageOpen` in the expanded-panel check. The content pane always shows the selection.
- **`useEscapeCloses`** (`components/window/useEscapeCloses.ts`), whose last user was
  the Usage page.
- **`bottomActions.uncoverBottom`** is collapsed, not removed. It still closes every
  sheet (`settingsOpen`, `usageOpen`, `themesOpen`) and unexpands the side panel. A
  shell this window starts (cmd+t, cmd+j on an empty panel, Run in terminal,
  `focusTerminal`) takes the keyboard, which it could not do under a modal. The same
  rule as PR 2. Its comments now say "a sheet" and not "the Usage page".
- `toggleBottomFromHere` under the Usage sheet used to be a no-op (the panel was
  hidden). Now it does what it does anywhere: on an empty panel it starts a shell, and
  the shell closes the sheet.

The side panel's Usage surface (`surfaces/usage.ts`, `stores/usagePanel.ts`) is a
different, pane-scoped thing and is untouched.

## Tests

- `e2e/usage-sheet.spec.ts` (new):
  - size at 1440×900 (the cap, centred) and 1000×700 (margin-limited);
  - the 44px header with its contents, and not a drag surface;
  - the chart button toggling, and Esc, the backdrop, × and the button closing, each
    returning focus to the thread's prompt;
  - the range and measure controls inside the sheet;
  - a tooltip's and the palette's and help's Escape leaving the sheet open;
  - Settings, Usage and Themes replacing each other with one dialog and one backdrop;
  - the panels staying under the sheet, and cmd+t closing it.
- `usage-page.spec`: the toggle test clicks the button's position (the backdrop) and
  changes the selection through `thread.next`. The screenshot test is at 1440×900.
- `bottom-panel.spec`: the bottom panel now stays under the Usage sheet (and keeps its
  live Attach).
- `zoom-popovers.spec`: the chart tooltip test moves the pointer to whole px (see
  Gotchas).
- Unit tests: the "no-op under the usage page" cases became "acts under a sheet" cases
  (views, views.split, bottomActions, SidePanel, the linked-PRs, usage and worktree
  surfaces). `bottomVisible`'s table lost its page column. `UsagePage.test.tsx` became
  `UsageSheet.test.tsx`. It renders the sheet and covers its role, title, focus, and
  Escape (through Radix).

## Gotchas

- Radix's modal hides everything outside the dialog from the accessibility tree
  (`aria-hidden` on its siblings). `getByRole` finds nothing under the sheet. A test
  that counts the bottom panel's tabs under it uses `locator('[role="tab"]')`.
- The sheet is centred by `translate(-50%, -50%)`, so what is inside it can sit at
  fractional px. WebKit's `clientX`/`clientY` are integers, so a test that moves the
  pointer to a fractional point and expects a pixel-exact answer is off by up to 0.5px
  times the zoom. Move to whole px.
- `DialogTitle` needs a `Dialog` around it, so `UsagePage` cannot render on its own in
  a unit test any more. The tests render `UsageSheet`.
- The comment in `dialog.tsx` changed, but the page library's minified `ui.js` did not
  (`make pagelib-check` is clean), so `internal/pagelib/dist` was not rebuilt.
