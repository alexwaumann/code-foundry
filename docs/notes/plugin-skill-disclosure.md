# Plugin skill: progressive disclosure

The code-foundry-plugin skill was 147 KB and most tasks had to open its largest files.
`SKILL.md` repeated what the references said, `primitives.md` and `host-api.md` sat near the
32 KB file cap, and every node was shown twice, as JSON and as Go.

## Decisions

- `SKILL.md` went from 9.1 KB to about 5.5 KB: a task-to-file table, the loop, and only the
  rules `Validate` cannot catch. Visual design rules moved to `primitives.md`.
- Split by topic, since an agent reads a file whole: `nodes.md`, `forms.md`, `events.md`,
  `wakes.md` (the manifest half and the FireWake half together), `owned.md` (the thread and
  terminal nodes and calls together).
- Go only in node examples: authors write Go, and JSON keys are the lowerCamel field names.
  One JSON example stays in `primitives.md`, and the act shapes stay in `ui-layout.md`.
- `primitives.md` gained a "Which node" table.

## Checks

- Every backticked token and number of the old skill was compared with the new one: the
  only ones gone are numbers from deleted JSON samples and paths now written in short form.
- A Sonnet 5.5 agent built a plugin (surface, toolbar filter, two commands, events, tests)
  from the skill alone. It passed and never opened `wakes.md`, `owned.md`, `protocol.md`,
  `publishing.md`, `cli.md` or `host-commands.md`.
- Its report found gaps, all checked against the SDK and fixed: refreshing an open view
  from a command, button builder signatures, `--source` against `Subscribe` names,
  `WorktreePath`, plugintest ignoring `confirm`. It read `host-api.md` and `ui-layout.md`
  whole for one section each, so `SKILL.md` now says to read by section.

## Gotcha

`plugin_test.go` pins strings per file, so moving a section means moving its pins.
