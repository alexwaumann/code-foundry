# Theme 4: form controls come from shadcn

Fourth of five PRs towards a theme engine (tokens, palette sweep, tooltip sweep, form
controls, radio-group + cleanup). The app's switches, select, text fields, text areas,
checkbox and labels were hand-rolled, each with its own class string (two copies of the
switch, a native `<select>` that WebKit draws unthemed). After this PR they are the shadcn
components, styled once in `components/ui/` from the tokens, so a theme reaches them.
Frontend only.

## Components added

`pnpm dlx shadcn@latest add switch input textarea label checkbox select` (shadcn 4.21.4,
new-york, radix-ui), committed as generated first (`6060dc33`) so the tweaks below are
their own diff. The CLI already imports `cn` from the `cn` package like the existing
`ui/` files.

## Wrapper defaults (once, in `components/ui/`)

| File | Change from the generated file | Why |
| --- | --- | --- |
| `input.tsx` | `h-8`, `px-2.5`, `text-sm` at every width (stock: `h-9`, `px-3`, `text-base md:text-sm`) | the app's density: dialog inputs were already h-8/text-sm; the window is a desktop app, the `md` step is for phones |
| `textarea.tsx` | `px-2.5`, `text-sm`; no `field-sizing-content` | WebKit (the app) ignores `field-sizing` while Chromium (the e2e's second browser) grows the field to its text, so the two engines would differ; callers size it (`rows`, PrAsk's fit) |
| `select.tsx` | trigger `h-8` (sm `h-7`), `px-2.5`; content defaults to `position="popper"`, `sideOffset={4}` scaled by the zoom, `max-h` and `min-w` from the `--radix-*` lengths divided by `--cf-zoom`, `min-w` on the content (not the viewport), `rounded-lg shadow-lg` | see Gotchas: item-aligned does not survive the page zoom; the viewport's min-w made the list 2px wider than its trigger; menus are rounded-lg/shadow-lg |
| `switch.tsx` | checked/unchecked from `aria-checked:` / `aria-[checked=false]:` and `group-aria-*/switch:` on the thumb, not `data-[state=…]` | a `Tip` around a control writes its own `data-state` on the same element (theme-3 handoff) |
| `checkbox.tsx` | `aria-checked:` instead of `data-[state=checked]:` | same |
| `label.tsx` | none | |

Sizes kept from shadcn: the switch (`h-[1.15rem] w-8`, a 16px thumb) is a little smaller
than the hand-rolled one (`h-5 w-9`); its colours are shadcn's (dark: a white track with a
dark thumb when on). No raw palette class in any of them (the guard passes).

## Call sites

| Where | Was | Now |
| --- | --- | --- |
| `settings/SettingRow.tsx` BoolEditor | hand-rolled `role="switch"` button | `Switch` |
| `settings/SettingRow.tsx` EnumEditor | native `<select>` | `Select` (trigger `w-full`, `data-value` = the setting's value) |
| `settings/SettingRow.tsx` TextEditor | `<input>` + `inputClass` | `Input` (remount key, Enter commits via blur, Escape reverts: unchanged) |
| `settings/SettingRow.tsx` KeybindingEditor | `<button>` + `inputClass` | `Button variant="outline" size="sm"` (`font-normal`, ring while recording) |
| `settings/SettingsPage.tsx` search | `<input>` | `Input` (`h-7 text-[13px]`: the pane header's size, next to its xs buttons) |
| `projects/ProjectsPage.tsx` filter | `<label>` box + `<input>` | `div` + `Input` (`h-7 text-[13px]`, as above); the input has its aria-label |
| `actions/ActionDialog.tsx` | local `Switch`, `inputClass`, two `<label>` | `Switch` (same test id and aria-label), `Label` + `Input`, `Label` + `Textarea` (mono, `rows={3}`, `resize-y`) |
| `addproject/NewTab.tsx` | `<input>`, native checkbox (`accent-primary`) in a `<label>` | `Input` (mono, sans placeholder), `Checkbox` + `Label` |
| `addproject/GitHubTab.tsx` | bordered box with an icon and a bare `<input>` | `Input` with the icon absolutely placed (`pl-8`), h-8 like the Look up button beside it |
| `publish/PublishDialog.tsx` | `<input>`, "Name" span | `Input`, `Label` |
| `snooze/SnoozeDialog.tsx` | `<label>` box + `type="time"` input | `Input type="time"` with the clock icon placed over it |
| `pr/PrAskComposer.tsx` | `<label>`, `<textarea>` | `Label`, `Textarea` (its fit-to-text height, 6-line cap and read-only dimming kept; the focus ring is now the shared 3px one) |

The six `<label>` elements: the two in the action editor, PrAsk's and the publish checkbox's
are `Label` now; the Projects filter's and the snooze time's only boxed an input with an
icon and are `div`s (the inputs have aria-labels). `inputClass` is gone from both files.

**Kept bespoke** (as decided): the composers (`compose/Composer.tsx`,
`thread/ThreadComposer.tsx`: TipTap editors plus hidden file inputs), the sidebar rename
field (`sidebar/SidebarRow.tsx`: inline in a row, row typography), the palette's cmdk
input, `thread/PendingPrompt.tsx` (inline answer fields in the docked prompt). Also kept:
the action editor's icon tiles and `PublishPicker`'s visibility radios (PR 5), the Settings
reset button (an icon button with a `Tip`).

## Task-list checkbox (markdown)

Native, read-only (GFM renders it disabled), now `accent-color: var(--info)` in
`index.css`: sky-600 in light (unchanged), sky-400 in dark. Compared in WebKit on PR
#145's test plan (mock), light and dark: sky-600 literal, `--info`, `--primary`, the
shadcn `Checkbox` disabled, and the shadcn `Checkbox` at full opacity. The native box
keeps a clear empty box in both schemes and WebKit dims it as read-only; the shadcn one
disabled goes grey at 50% and its empty box all but vanishes on the dark pane, and at full
opacity it reads as a control to click. Native also leaves the markdown's DOM (and the
sanitizer's `input`) as GitHub sends it.

## Gotchas

- **Radix Select under the page zoom.** shadcn's default `position="item-aligned"`
  positions the list itself (a fixed wrapper with `left`/`top` from
  `getBoundingClientRect`, viewport px) inside `<html>`'s CSS zoom, so it would land
  zoom-times off, the bug `zoom-popovers.md` fixed for poppers (read from Radix's code,
  not measured: item-aligned was never shipped). `position="popper"` goes
  through `[data-radix-popper-content-wrapper]` and the index.css counter-zoom. The
  `--radix-select-trigger-width/height` and `--radix-select-content-available-height`
  are viewport px too, so they divide by `--cf-zoom`. e2e: `zoom-popovers.spec.ts` at 100
  and 125%.
- **Radix Select cannot hold `""`** as an item value (it means "no value"), and an enum's
  "" is "no preference" (Default). The editor maps it to `__cf_default__` both ways.
- **Escape on the Settings page.** `useEscapeCloses` listens on the window in the capture
  phase, before Radix; with a select open the focus is on an option, not a field, so
  Escape closed the whole page. It now ignores keys from `[role="combobox"]` (the closed
  trigger, as the native select was ignored before) and from inside
  `[data-radix-popper-content-wrapper]` (any open popper), and Radix closes the list.
- **While a select is open Radix hides everything else** from the accessibility tree
  (`aria-hidden`, `hideOthers`), the trigger included, so e2e finds the trigger by
  `data-slot="select-trigger"`, not `getByRole("combobox")`. The list is
  `[data-slot="select-content"]`: `getByRole("listbox")` also matches the sidebar once the
  select is closed.
- **Radix form controls render a hidden native input inside a `<form>`** (the action
  editor's switch, the New tab's checkbox) and measure the trigger with `ResizeObserver`,
  which jsdom lacks: `src/test/setup.ts` defines a no-op one for every unit test.
- **Focus in dialogs** (`actions-2-gui.md`): WebKit does not focus a button on click, so
  after clicking the Radix switch the keyboard is still on the dialog's content; Cmd+Enter
  keeps working because the editor handles it on `DialogContent`, unchanged.
- The `Label` puts `leading-none` on its text; where it labels a field in a column
  (`text-xs` in the action editor) the label is 4px shorter than the old span.

## Tests

- Unit: `settings/SettingRow.test.tsx` (new): the switch commits the flip, the select shows
  the value, lists "(default)" and Default, and maps Default to "", the text input's
  Escape and Enter. The guards (`palette.test.ts`, `tooltips.test.ts`) pass over the new
  `ui/` files.
- e2e `settings.spec.ts`: helpers `select`, `pick`, `expectOptions` replace
  `selectOption`/`toHaveValue`; new: the select from the keyboard (Enter opens on the
  selected option, ArrowDown + Enter picks, focus back on the trigger, Escape leaves the
  page open, the list under the trigger as wide and drawn in `bg-popover`) and a text
  setting's Escape/Enter. `zoom-popovers.spec.ts`: a settings select at 100 and 125%.
  `create.spec.ts`' `check()`/`uncheck()` work on the Radix checkbox unchanged.

## Verified

- `make check` green (frontend 2883 tests before the rebase onto #114, 2921 after;
  no Go change on this branch).
- `make gui-e2e` (WebKit + Chromium): 771 passed, 40 skipped, 1 failed: the new
  keyboard-select test on Chromium, which pressed Enter before Radix had moved the focus
  to the next option (Radix moves it in a timeout). The test now waits for the focus; it
  then passed 10 of 10 (`--repeat-each=5`, both browsers), and `settings.spec.ts` and
  `zoom-popovers.spec.ts` pass whole. The known `panel.spec.ts` flake did not show.
- After rebasing onto #114: settings, zoom-popovers, actions, create, addproject, snooze,
  projects, pr-panel and sessions specs on both browsers, 210 passed, 4 skipped.
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`, a scratch repo under `~` and one
  unprompted Haiku thread, all deleted afterwards), dark and light:
  - Settings: the select opens under its trigger, as wide, in the popover colours; arrows
    move the highlight, Escape closes only the list (the page stays, focus on the
    trigger), Enter picks and saves with its toast; reset puts the default back; the
    switch saves off and on; a number field reverts on Escape and saves on Enter. At 125%
    zoom (cmd+= twice) the effort select's list stays anchored and as wide.
  - Add Project: the New tab's name field and its invalid state, the Publish checkbox
    toggled from its label (the owner lookup starts), the GitHub tab's field beside Look
    up.
  - Action editor (Edit, from the Play menu by ArrowRight): Name, Command (a second line),
    the switch on, the Command label focusing the textarea; Cmd+Enter right after a tile
    click saved the name, command, icon and switch (checked with `action.list`).
  - Publish dialog (Projects page, not submitted), the Projects filter (typing, Escape),
    the snooze dialog's time field (typing the hour).
- Not seen live: the PR Ask composer and the markdown task list (no GitHub remote in the
  scratch repo); both are covered by unit and e2e tests, and the task-list colours were
  compared in WebKit on the mock (above).
- Screenshots (live, Wails window): `theme-4-forms/settings-select-dark.png`,
  `settings-select-light.png`, `actions-dialog-dark.png`.
- No daemon change: no restart needed.

## PR 5 (radio-group, skeleton, kbd, progress)

- `pnpm dlx shadcn@latest add radio-group skeleton kbd progress`, then restyle the
  generated `data-[state=checked]` selectors to `aria-checked:` like the switch and
  checkbox here (a `Tip` on an item overrides `data-state`).
- `publish/PublishPicker.tsx` imports `RadioGroup` from `radix-ui` directly and already
  styles checked from `aria-checked:`; the shadcn `RadioGroup`/`RadioGroupItem` take over.
- The action editor's icon tiles (`ActionDialog.tsx` `IconTiles`) are a hand-rolled
  `role="radiogroup"` of buttons, each its own tab stop; a RadioGroup gives them one
  tab stop and arrow keys. Keep `data-testid="action-icon"`/`data-icon` and the Cmd+Enter
  path (a tile click leaves focus on the content in WebKit).
- Seven `<kbd>` stylings (grep `<kbd`), among them the Projects filter's `/` hint inside
  the `Input` this PR added.
- The update dialog's `ProgressBar` (`update/UpdateDialog.tsx`) is indeterminate
  (`aria-busy`, a sliding bar); shadcn's `Progress` is determinate (`value`), so it needs
  an indeterminate variant or a value.
- Two PR skeletons (`animate-pulse` in `pr/PrSummary.tsx`, `pr/PullRequestSurface.tsx`,
  and `linkedprs/LinkedPRsSurface.tsx`).
- `Input` and `Select` are h-8; a control in a pane header passes `h-7 text-[13px]`.
