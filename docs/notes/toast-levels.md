# Toast levels (PR 1 of 3)

Every toast now looks like its level and goes through one function. PR 2 gives plugins
and the SDK the same levels and a title/body split; PR 3 decides which success toasts
stay. This one changes how toasts look and how they are called, not which ones exist.

## The look (agreed sketch "B")

- A level tints its card: the level's `--cf-*-surface` slot (10% alpha) layered over
  `--cf-surface-overlay` as a one-colour gradient on top of the overlay background, so the
  card is opaque and a user theme's tint carries through. The border is
  `color-mix(in oklab, var(--cf-<level>) 32%, var(--cf-surface-overlay))`. No new slots.
- Icon (the lucide ones as before) on the title line in the level's hue; title
  `text-body-sm font-semibold` in `--cf-<level>-text`; description `text-body-sm` in
  `--cf-text-secondary`, hanging under the title. Long text wraps (`overflow-wrap: anywhere`).
- Buttons stay neutral (action: text colour fill; cancel: a 10% text tint) on their own row
  under the body. A sticky toast's close button sits at the title line's end.
- Loading (a state, not a level) and a page's level-less `toast()` keep the neutral card.

## How it is built

- `components/ui/sonner.tsx` passes `toastOptions={{ unstyled: true, classNames }}` and the
  classes are the whole look. Sonner's styled sheet is unlayered CSS, and unlayered rules
  beat Tailwind's layered utilities whatever their specificity, so overriding the styled
  toast with classes would lose; unstyled drops those rules. What unstyled also drops and
  the card needs back: `width: var(--width)`, the stacked toasts' hidden content
  (`data-[expanded=false]:data-[front=false]:*:opacity-0`), and `position: relative` on the
  icon box (sonner centres its loader absolutely inside it: without it the spinner landed
  in the middle of the title).
- The layout is a grid: `[1.5rem auto auto minmax(0,1fr) auto]` = icon (16px + 8px), cancel,
  action, the rest, close. The body spans the middle three; the buttons sit on row 2 (the
  action moves to column 3 after a cancel, `[[data-cancel]+&]`). An absent cancel or close
  leaves its column 0 wide.
- A level's classes only set `--level`, `--level-surface`, `--level-text` and
  `--level-border`; the card reads each with the neutral fallback. Setting a default for
  the same property in the base classes would race the level's (Tailwind orders same-property
  arbitrary utilities on its own terms), hence the fallbacks.
- Sonner always gets `theme="light"`. Its dark sheet has unlayered rules for the description
  colour and the close button that apply even to unstyled toasts and would win over the
  classes; the light sheet only sets variables the card does not read. The colours follow
  the scheme through the cf slots, so App.tsx no longer passes `theme`.

## notify

`src/lib/notify.ts`: `notify({ level, title, description?, action?, cancel?, id?, duration?,
sticky? })`, `notifyProgress({ title, description?, id? })`, `dismissNotice(id?)`.

- `sticky` is `duration: Infinity` plus the close button (a failed git op, a failed setup run).
- Every option is passed to sonner on every call, set or not: sonner merges an update into
  the toast it replaces (same id), so a result replacing a progress toast must clear the
  description or buttons it does not set. A unit test pins this.
- Progress sets no duration: sonner never times out a loading toast, and the result that
  replaces it then gets the Toaster's default unless it sets one (git ops set 5 s).
- `src/design/toastGuard.test.ts` fails on any file under src, tests included, that names
  the `"sonner"` module (import, re-export, dynamic or type import, `vi.mock`) except
  `lib/notify.ts` and `components/ui/sonner.tsx`. Tests mount the Toaster from
  `components/ui/sonner` and mock `@/lib/notify`.

## Wording rules applied at the call sites

- A title is short and never holds an error message, a path or a daemon sentence. Short
  names (a project, a file, a command title) are fine in it.
- The generic command toast (`runCommandForResult`) now shows the command's title as the
  title and the daemon's message as the description, for success as it already did for
  failure ("X failed" + reason). Daemon messages are CLI sentences, often lower case.
- Daemon warnings get a title from the call site ("Thread started with a warning", "Moved
  with a warning"); plugin toasts and daemon notify intents keep their mapping, the
  plugin's text as the title (PR 2).
- Level-less `toast()` calls became info, except "Disabled <skill>" with the restart
  warning, which is a warning.

## Pages

A page imports `toast` and `Toaster` from `@cf/ui` and draws its own Toaster inside its
frame (docs/notes/page-library.md). `toast` now comes from `components/ui/sonner.tsx`
(re-exported there) instead of `pagelib/ui.ts` importing sonner itself; ui-exports.json is
unchanged. `ui.css` scans `components/ui`, so a page's toasts get the same card; its
`toast("text")` (no level) is the neutral card. The page-facing API is unchanged.

## Tests

- `lib/notify.test.tsx` (a real Toaster): each level's card and icon, description, buttons
  (cancel before action, onClick then close), sticky close, progress → result in place,
  a replace clears unset options, dismiss by id.
- `e2e/toasts.spec.ts`: the computed colours per level in dark and light (only the real
  theme CSS shows them); `SHOTS=<dir>` saves the PR screenshots. `devModules.ts` exposes
  `lib/notify.ts` to the bundled dev build for it.
