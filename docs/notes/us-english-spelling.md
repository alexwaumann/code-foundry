# US English in user-facing copy

What the user reads (GUI text, aria labels, toasts, tooltips, command titles and
descriptions, CLI messages, errors a command or store returns) is US English: color,
organization, customize, canceled, labeled, centered. Part 4 of the messaging and settings
pass; part 3 (#876) already did the settings schema and its mock.

## What stays

- Identifiers: `customiseTheme`, `ColourPicker`, `setBaseColour`, `scopeColours`,
  `SameColours`, the `colour-*` test ids, `SetupCancelled`, `errCancelled`. Renaming them
  is churn with no reader.
- State values and wire keys: the `"cancelled"` setup, request and Ember task states, the
  `cancelled` count field, `ReasonSetupCancelled` (`"setup cancelled"`, a stored status
  reason), and the `"cancelled"` sentinel errors the frontend compares against.
- Text that names an accepted value: `ember task` descriptions and its counts line say
  `cancelled` because `--state cancelled` is what the CLI takes. The GUI's words for the
  state (`stateWords`, `linkWords`) say "canceled": they are labels, not values.
- Comments, log lines (`slog`), `docs/notes/`, the agent skills under
  `internal/skills/files/` and mock fixture prose (sample threads, PR text).

## Gotchas

- Slot rules (`src/themes/slots.ts`) and slot uses (`slotUses.ts`) are shown in the theme
  editor's detail view, so they are copy; `internal/theme/file.go`'s retired-slot hint
  matches `slots.ts`'s and changed with it.
- The mock mirrors command titles and messages (`mock/world.ts`, `mock/userThemes.ts`,
  `mock/skills.ts`, ...): change both sides.
