# Composer and shelf polish (2026-10-28)

Small redesigns a user asked for in one pass; GUI only, no daemon change.

## What changed

- The sidebar's Working, Snoozed and Archived headers are title case (`text-caption font-medium`,
  13px) instead of the 11px uppercase overline. The count moved from beside the label to the
  right, just before the chevron. Test ids and the "Working 2" accessible name are unchanged.
- The new-thread heading's project name is semibold; the sentence around it stays regular. The
  heading already said "in <project>"; "with" remains only for No project.
- Both composers' Model picker shows the Claude mark (`ClaudeMarkBrand`, Claude orange, the
  same 14px box as the lucide icons beside it) instead of lucide's Brain. `ComposerPicker.icon`
  accepts any svg component now, not only a `LucideIcon`. The Themes gallery mock follows.
- The Start thread / Send button with nothing to send is a neutral grey (`SEND_DISABLED`:
  sunken surface, muted text) instead of the accent at 40% opacity. With text or an attachment
  it is the accent, as before; the in-flight phase pill is unchanged.
- The Work in dropdown's "Project folder" row no longer prints the checkout path. Every
  single-project case (git or not) says "Edits land in the project's checkout directly. One
  thread at a time is safest."; the multi-project wording is unchanged.
- Placeholders teach the two gestures. New thread: "Ask anything. @ files and threads, / skills
  and commands". Existing thread idle: "Reply or ask anything. …"; while the agent works:
  "Steer the agent mid-turn. …" (replaces "Send a follow-up… Claude picks it up mid-turn").
  Ember's pane keeps its own copy via the `placeholder` props.

## Decisions

- "Agent", not "Claude", in the busy placeholder (the user's wording).
- The mark is orange in the pickers, matching the sidebar tooltip's model row, rather than the
  muted currentColor of the other picker icons. One-line change in `ClaudeMark.tsx` if not.
- The "WORK IN" group heading inside the picker is still an overline; only the sidebar shelves
  were in scope.

## Verification

`make check`; `e2e/composer-polish.spec.ts` (header case and count position, placeholders,
project-folder detail, neutral vs ready send colour; `SHOTS=<dir>` writes the PR's screenshots).
Run it on free ports when another worktree's e2e is up:
`E2E_MOCK_PORT=7830 E2E_VITE_PORT=9270 E2E_WORKERS=1 pnpm exec playwright test e2e/composer-polish.spec.ts --workers 1`.
