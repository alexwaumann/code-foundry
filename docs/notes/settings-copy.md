# Settings copy and validation text

PR 2 of the messaging and settings overhaul: wording only, plus the Themes page's scheme
order. No setting's key, value, default or behaviour changes.

## Decisions

- Client validation (`gui/frontend/src/settings/validate.ts`) speaks as an instruction that
  ends with a full stop: "Enter a whole number.", "Enter a number from 9 to 28.", "Enter true
  or false.", "Enter an absolute path (or ~/…).". The rejected input is no longer echoed back;
  the field still shows it. Enum got "Choose one of a, b." to match, although a select rarely
  shows it. The daemon's own messages in `internal/store/settings/schema.go` are unchanged:
  they also reach the CLI and the file's issue list, where "want" reads fine.
- Shortcuts in copy are glyphs in macOS order (⇧ before ⌘): ⇧⌘I, ⇧⌘G, ⌘K, ⌘1–9. Code
  comments keep the `cmd+k` spelling the keymap uses.
- One phrasing for where ignored files show up: "Go to File, @ in the prompt and text
  search", in the Files section and group, the field and `IncludeIgnoredSettings.tsx`.
- Dictation's model row drops "Nothing you say leaves this Mac": the page description right
  above it already says audio never leaves this Mac.
- The Themes page's scheme control is System, Dark, Light, like the Scheme setting and the
  dark-first slot chips beside it.
- Every schema string changed in Go is changed identically in `gui/frontend/mock/settings.ts`.

## Left alone on purpose

Copy for `threads.default_model`, `threads.default_snooze`, `threads.auto_archive_after`,
`threads.cache_ttl_seconds`, `dictation.anywhere`, `sidebar.needs_scope`,
`projects.branch_prefix`, `projects.branch_instructions` and Browse themes; the Themes page's
tooltips and its Customise spelling; dependencies and search (`DependsOn`, `hiddenFields.ts`,
`keyEditors.ts`, `ownDescriptionKeys`), which the next PR takes.
