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

Two more moves, after review, to leave at least six spare lines under the cap:

- The Conventions line on plugin wake sources (`thread subscribe --plugin
  <plugin>/<source> --arg ...`, `code-foundry plugin wakes`) is the last section of
  wakes.md, "Plugin wake sources".
- Step 4's detail (`git diff --name-only origin/<default>...<branch>` per branch or
  `git merge-tree --write-tree`, read both diffs of a shared file, same flag parsing and
  types, not only whether git merges) is `reference/patterns.md` §8, "Checking a batch
  before the roll-up". Step 4 keeps two lines: whether branches that touch one file fit
  together, tell the user what overlaps or conflicts, and the §8 pointer.

SKILL.md keeps the four wait choices, "Pick ONE" with the `--notify` rule, the
ordinal/`--after` and timeout sentence, and a four-line summary of what a wake carries
ending in "Before you act on a wake, read `reference/wakes.md`" (it restates "never
`send --wait`" from a wake turn, the rule most costly to miss). The Leads section keeps
four lines: the "You are a lead" prompt line, no new worktree, the progress report
before ending a turn with workers running, and the pointer. "More" lists both files
and §8.
Only light rewording: "**After the app restarts** (a wake says so, or the user does)"
became a section heading plus "When a wake says the app restarted, or the user does".
No rule was added or dropped.

## Cap and test

- SKILL.md is 123 lines; the cap in `internal/skills/skills_test.go` drops from 160 to
  130 (seven spare lines) so the freed room cannot quietly fill up again: new material
  goes behind a pointer too.
- The pointer table in the same test now names the file each pointer lives in: §5 and
  §6 are pointed at from wakes.md (they moved with their sentences), §7 and §8 from
  SKILL.md. It checks wakes.md has its sections (pending prompts, `report_stale: true`,
  a batch of wakes, After the app restarts, WITHOUT `--wait`, Plugin wake sources),
  leads.md its heading and the progress-report rule, patterns.md its §8, and that
  SKILL.md points at both new files.
- TestRender's file list gains the two files (the static files are embedded by
  directory walk, so no Go change).

## Why

Room for the upcoming sidebar-visibility material, which a later PR adds as
`reference/sidebar.md` with one pointer line in SKILL.md.

## Gotchas

- The brief aimed at 100-110 lines. The wake and lead material freed 33 lines (160 to
  127), the plugin line and step 4's detail four more (123); getting lower would mean
  moving step 1's child-prompt paragraph or the rest of Conventions, which the
  orchestration experiments tested in SKILL.md itself, so they stayed.
- Nothing else copies the skill text: `internal/guide/guide.go` has its own wording
  (one line on a lead's `progress` settle), and the older notes
  (`orch-skill-v2.md`, `orch-skill-v3.md`, `orch-restart-wakes.md`) quote it as
  history; none changed.
- Reference files point at siblings by the skill-root path (`reference/patterns.md`),
  as SKILL.md does.
