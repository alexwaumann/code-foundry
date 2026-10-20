# Orchestrate skill split (2026-10-20)

The code-foundry-orchestrate SKILL.md sat at its 160-line cap (159 lines after
orch-skill-v3, 160 by the time of this change), so nothing new could go in without
deleting a tested rule. This change uses progressive disclosure instead: the dense
wake and lead material moves into two reference files, SKILL.md keeps the skeleton and
a pointer to each. Skill text and its test only; no CLI, daemon or guide change.

## What moved where

`internal/skills/files/code-foundry-orchestrate/reference/wakes.md` (new) takes all of
step 2 of "The loop" past the "Pick ONE" rule (except the waiting sentences on the
ordinal and timeouts), one section each:

- Following up from a wake turn: `thread send --id <child>` WITHOUT `--wait`, then end
  the turn; the subscription fires again.
- Finished, or a stale report: `needs attention (finished)`, `report_stale` and
  `last_message`.
- Pending prompts and questions: `pending` (`request_id`, tool `input`, `options` for
  `thread respond --answer`), answer pending requests before relaying a question, the
  supervised-children pointer (`reference/patterns.md` §5).
- Budget stops, with the pointer to §6.
- A batch of wakes: `thread reports --created-by $CODE_FOUNDRY_THREAD --all`, talk to
  the user only when needed, do a check now or not at all.
- Messaging a child: not a finished one only to inform it, a send to a working child is
  read at its next tool call (`thread interrupt` first), `thread rename`.
- After the app restarts: the whole paragraph (reports `--all`, `thread list
  --created-by`, `error (interrupted)` children, subscriptions survive).

`reference/leads.md` (new) takes the "Leads (children that orchestrate)" section
verbatim, under the same heading.

SKILL.md keeps the four wait choices, "Pick ONE" with the `--notify` rule, the
ordinal/`--after` and timeout sentence, and a four-line summary of what a wake carries
ending in "Before you act on a wake, read `reference/wakes.md`" (it restates "never
`send --wait`" from a wake turn, the rule most costly to miss). The Leads section keeps
four lines: the "You are a lead" prompt line, no new worktree, the progress report
before ending a turn with workers running, and the pointer. "More" lists both files.
Only light rewording: "**After the app restarts** (a wake says so, or the user does)"
became a section heading plus "When a wake says the app restarted, or the user does".
No rule was added or dropped.

## Cap and test

- SKILL.md is 127 lines; the cap in `internal/skills/skills_test.go` drops from 160 to
  130 so the freed room cannot quietly fill up again: new material goes behind a
  pointer too.
- The pointer table in the same test now names the file each pointer lives in: §5 and
  §6 are pointed at from wakes.md (they moved with their sentences), §7 still from
  SKILL.md. It checks wakes.md has its sections (pending prompts, `report_stale: true`,
  a batch of wakes, After the app restarts, WITHOUT `--wait`) and leads.md its heading
  and the progress-report rule, and that SKILL.md points at both files.
- TestRender's file list gains the two files (the static files are embedded by
  directory walk, so no Go change).

## Why

Room for the upcoming sidebar-visibility material, which a later PR adds as
`reference/sidebar.md` with one pointer line in SKILL.md.

## Gotchas

- The brief aimed at 100-110 lines. Moving exactly the wake and lead material frees 33
  lines (160 to 127); getting lower would mean moving step 1's child-prompt paragraph or
  the Conventions list, which the orchestration experiments tested in SKILL.md itself,
  so they stayed. The plugin wake-source convention line would also fit wakes.md if
  more room is needed later.
- Nothing else copies the skill text: `internal/guide/guide.go` has its own wording
  (one line on a lead's `progress` settle), and the older notes
  (`orch-skill-v2.md`, `orch-skill-v3.md`, `orch-restart-wakes.md`) quote it as
  history; none changed.
- Reference files point at siblings by the skill-root path (`reference/patterns.md`),
  as SKILL.md does.
