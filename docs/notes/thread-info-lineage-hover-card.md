# Thread info card: lineage hover card

A user asked for two fixes to the hover card on a lineage row (a subagent run or a
child thread) in the thread info card (docs/notes/thread-info-card.md).

## Decisions

* **Instant open.** The row's `Tip` passes `delay={0}`, as the sidebar's thread hover
  card does (SidebarRow's `delayDuration={0}`). The card is the row's content, not a
  hint, so the app root's 500 ms delay was a wait for nothing. The stop square's
  "Interrupt this thread" tip keeps the provider's delay: it is a hint.
* **Readable model name.** The card printed the raw id (`claude-opus-4-8[1m]`). It now
  goes through `canonicalModelName` from `lib/models.ts`, the same rule the subagent
  view uses (SubagentPane's `useRunModel`): the registry label for a known id, else
  the family and version read from the id. A subagent run that asked for no model
  (`r.model` empty) used its thread's model, so the card shows that, again as the
  subagent view does. A child thread shows its own model only.
* **Bare aliases.** The Agent tool takes a family alias (`haiku`, `opus`), and the
  registry lists pinned ids only (docs/notes/model-registry.md), so such a run's model
  did not match anything and would have printed lowercase. `canonicalModelName` now
  capitalises a bare alias (`haiku` → `Haiku`), the registry's label for that alias
  winning when one exists. Pinned in `models.test.ts`.

## Verification

`make check`; `lineage.spec.ts` and `subagent-view.spec.ts` against the mock; a
throwaway Playwright spec (not committed) hovered a row of the scripted agents thread
in dark and light for the PR body and read "Opus 4.8" from the card.
