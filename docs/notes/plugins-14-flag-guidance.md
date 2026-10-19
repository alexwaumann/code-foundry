# Plugins 14: choosing a flag mode (2026-10-18)

Skill guidance only; no daemon, SDK or GUI change. `thread/setFlag` already has two modes
(`docs/notes/plugins-3-events-flags-env.md`): until seen (cleared when a viewer opens the
thread) and sticky (`untilSeen: false`: stays until the plugin sets `none`, the thread is
archived, the plugin is disabled, or the user clears it with the header chip's × or
`thread flag clear`, `docs/notes/plugins-11-gui-gaps.md`).

## Decisions

* **The mode is the plugin's choice** (Alex, 2026-10-18), but the skill makes the trade-off
  explicit: until seen for a one-off event (a failed CI run), sticky for a condition the
  plugin clears itself when it ends (tests failing).
* **A sticky flag must leave a visible way out**: the plugin's own clear command (manifest
  command, so palette and CLI have it, with a button in the surface), or a line pointing at
  the header chip's × and `thread flag clear <id> --plugin <name>`. A sticky flag held up by
  a plugin quirk would otherwise be maddening.
* **Never re-raise a flag the user cleared until the condition changes.** The plugin is not
  told about a user's clear (a `threads` subscription sees it leave `Thread.flags`), so the
  guidance is to remember the condition flagged, not whether the flag is up.
* Where: a "Choosing a flag mode" paragraph in `reference/host-api.md` under SetFlag, and
  one rule in SKILL.md's design rules. SKILL.md sits at its 120-line cap
  (`skills_test.go`), so two neighbouring rules were tightened to make room.

## First adopter

test-watcher 0.1.3 (`alexwaumann/code-foundry-plugin-test-watcher`) switched its failing
tests flag to sticky with a "Clear flag" action and the no-re-raise rule.
