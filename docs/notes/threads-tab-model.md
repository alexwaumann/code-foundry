# Threads tab: each row's model and effort (2026-10-23)

A user asked that a thread's children in the side panel's Threads tab
(`agents-3-lineage-gui.md`) show the model and effort they run with. Frontend only: the
thread list already carries `model`, `effort` and `effortPending`.

## Decisions

* **Every row, not only children.** `LineageRow` is shared by the Created by, This thread,
  Siblings and Children sections, so they all show it; a sibling or the creator is just as
  likely to be on a different model. The removed creator's inert row has nothing to show
  (the GUI no longer has that thread) and is unchanged.
* **Line 2, after the place, before the age**: "code-foundry @ fix/resize · Sonnet 5 ·
  high  18m". Line 1 already holds the name, "this thread", "hidden" and the status word;
  the model there cut names to a few characters at the panel's narrowest width (about
  340 px of content). The brief's "status first" assumed the status sits on line 2; here
  it is line 1's trailing word, so the status still reads before the model.
* **The model words never shrink; the place truncates instead.** Letting them shrink a
  little gave "Opus 4.8 · hi…" at 340 px, which says nothing. The longest pair ("Sonnet 5.5
  · xhigh") still leaves the place a readable prefix at that width.
* **Words**: `modelLabel` (the registry's short label via `useModelChoices`, the raw id for
  a model the registry does not list, "Default" when unset), as the sidebar row tooltip
  names it; the effort as its lowercase value ("high", "xhigh"), as the subagent view's
  lineage line has it, dropped when empty. Separated by the muted "·" at 60%, the same
  treatment as the place's "@". Line 2's caption style (muted) for the words themselves.
* **A pending effort change** (`effortPending`): the row shows the new level, as the
  composer's picker does, in italic, with a tooltip in the composer's words: "Effort
  changes to high after this turn" while the thread works, "Switching to high effort…"
  otherwise.
* **Narrow selectors**: `ModelWords` selects `model`, `effort` and `effortPending`
  separately, so a sibling's effort change re-renders only its own words.

## What changed

* `gui/frontend/src/components/lineage/ThreadsSurface.tsx`: `ModelWords` on line 2.
* `gui/frontend/mock/world.ts`: the lineage seed's threads have varied models and efforts
  (they were all Haiku 4.5 at medium).
* Tests: `src/surfaces/threads.test.tsx` (the words on every row, their place on line 2,
  an unknown model id, an unset model, the pending italic); `e2e/lineage.spec.ts` (the
  words of every row in order, line 2's order, a busy child's effort change waiting on its
  turn: italic and its tooltip). Its `SHOTS=<dir>` run also saves the creator's tab
  (`threads-tab-model-{dark,light}.png`, the panel only).

## Verification

`make check` green; `pnpm exec playwright test e2e/lineage.spec.ts e2e/panel.spec.ts`
green (WebKit). Checked at 340 px panel content width with a throwaway spec (not
committed). Daemon restart: not needed (frontend only).
