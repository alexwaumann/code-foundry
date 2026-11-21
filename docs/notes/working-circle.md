# Working circle

One mark for "a thread or check is working or waiting": a dashed circle that turns slowly.
Before, the sidebar, the rail and the pull request page showed a still dashed circle for a
live state, and a thread's live turn header ("Working · 9 steps · 9m 5s") showed a spinner.
Agreed with a user on a sketch: working turns once in about 5 s in the info tone, waiting
once in about 11 s, muted, linear, forever; nothing else moves.

## Decisions

- **One component.** `components/status/StatusCircle.tsx`: `<StatusCircle tone="working" |
  "waiting" className=… />`, the lucide `CircleDashed` with the tone's colour
  (`text-cf-info-text` / `text-cf-text-muted`) and motion (`animate-status-working` /
  `animate-status-waiting`, from `--animate-status-*` in `index.css`'s `@theme`, keyframes
  `cf-status-turn`). A colour class in `className` replaces the tone's (tailwind-merge).
- **Icon tables keep their shape.** `WorkingCircle` and `WaitingCircle` are the same circle as a
  `LucideIcon` (forwardRef, lucide's props) that takes `text-current`, so a table that sets the
  colour on the text around the icon keeps doing so: `statusRegistry` (working and setting up
  get `WorkingCircle`, waiting `WaitingCircle`), the rail's Working section, and the pull
  request readiness card's `running` icon (amber, the card's tone).
- **Phase.** Each circle takes a negative `animation-delay` of `performance.now() % period` when
  it mounts. A circle that mounts again (a virtualized sidebar row scrolled back, the live turn
  header, which mounts its icon a second time as the thread view settles) carries on where it
  was instead of jumping back to the top, and every circle of a tone turns in step.
- **Calm.** Transform only, on the icon's own fixed box: nothing lays out or repaints around it.
  A status indicator, not a user action, so the "frequent actions are instant" rule does not apply.
- **Turns under Reduce Motion.** The circle first carried `motion-reduce:animate-none`, so on a
  Mac with Reduce Motion on every working and waiting circle stood still. A user with the setting
  on reported that the circles never move, and decided: this animation is semantic (it says
  something is running), and Reduce Motion is for transition and interaction animations, so the
  circle ignores the setting. Same reasoning as the arrival tilt (`docs/notes/arrival-tilt.md`)
  and Ember (`components/ember/ember.css`). Only the dashed circle: spinners
  (`LoaderCircle`/`Loader2`) and other transitions keep their reduced-motion handling.
- **Only these two things.** Button pending states, loading placeholders and the plugin
  `running` status keep their spinners. A running row inside a turn (the collapsed work
  strip's running step, a running tool or Agent row) has no mark of its own since
  `docs/notes/running-rows.md`: its tool icon in the info tone and its label shimmering.
  Ember's live work line has the working circle, like a thread's live header.

## Every dashed circle, decided

| Site | What it marks | Decision |
| --- | --- | --- |
| `lib/statusRegistry.ts` `working` | a thread working (sidebar row, rail tile, rail hover card rows, theme gallery sample) | turns, working |
| `lib/statusRegistry.ts` `settingUp` | a thread's worktree being set up | turns, working |
| `lib/statusRegistry.ts` `waiting` | a thread waiting on its children | turns, waiting |
| `components/sidebar/rail/RailSections.tsx` Working | the rail's Working section icon (the registry's) | turns, working |
| `components/pr/ReadinessBox.tsx` `running` | the readiness card for running checks ("3 checks running", "Waiting on checks") | turns, working, in the card's amber |
| `components/pr/ReadinessBox.tsx` `none` | "No checks", "N checks skipped", unknown state | still |
| `components/prs/PrBits.tsx` `ChecksBadge` | the checks badge with no checks (tone `none`); pending uses `CircleDot` | still |
| `components/pr/checkIcons.ts` `skipped` | a skipped check | still |
| `components/plugin/tones.ts` `""` and `pending` | a plugin step with no status or not started; `running` has its own spinner | still |
| `components/thread/rows.tsx` `TurnHead` | the live turn header (was `LoaderCircle` spinning) | turns, working |

A single running check (`checkIcons` `pending`, the `ChecksBadge` pending tone) keeps its amber
`CircleDot`: the readiness card already said its own mark and a check's dot differ, and this
change only animates circles that were dashed already.

## Gotchas

- `src/design/scan.ts` blanks `index.css`'s `@theme inline { … }` up to its first `}` for the
  colour guard, so a nested block (`@keyframes` inside `@theme`) breaks the guard. The keyframes
  live at the top level beside `cf-indeterminate`.
- oxlint's `only-export-components` refuses a factory that returns components; the two icons
  are declared with `forwardRef` directly.
- `e2e/status-circle.spec.ts` checks the compiled turn (`getAnimations()`: `cf-status-turn`,
  5000 / 11000 ms, infinite) and that it still turns under emulated reduced motion, polling because the live header remounts its
  icon once. `SHOTS=<dir>` saves the turn header, the sidebar and a running checks card.
