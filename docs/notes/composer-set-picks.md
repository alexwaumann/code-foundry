# Composer: project set picks (2026-10-28)

How the new-thread composer's heading picker, chip row and pills behave after a user's
feedback. GUI only; no daemon change, no restart needed.

## What changed

- **Heading picker is a single pick.** A workspace row makes its members the set and it the
  reference; a project row makes that project the whole set (no workspace); No project moves
  the draft as before. Every pick closes the list. The current target's row is checked (the
  referenced workspace, or a lone project); an ad hoc set checks nothing. Placeholder:
  "Switch to a workspace or project…". `setDraftProject` is new; `pickDraftWorkspace` no
  longer toggles the reference off when picked again.
- **Add project is the multi-select**, first in the chip row so it never moves as chips come
  and go. Every registered project by name, the set's checked (`data-checked`); a row toggles
  its project and the list stays open (`ComposerPicker.multi` + `selected`) until Esc or a
  click away.
- **Workspace chip ×** takes the workspace and the members it brought out of the set;
  projects added on top stay (`removeDraftWorkspace`). The last project of a plain set can go
  too: the composer's empty state ("Pick a project") follows, as it already did for a
  workspace's last member. Chip × buttons have no tooltip (aria-labels only).
- **Clear** at the end of the chip row when there is more than one chip (`clearDraftSet`).
- **Pills:** Work in and Branch from on the left, Run in (was "Runs in") on the right
  (`ml-auto`), so Run in stays put as Branch from comes and goes.
- **Focus goes to the prompt** after every pick, ×, Clear, Esc and click away: the heading
  picker, Add project and the three pills (`ComposerPicker.focusAfter`). The model, effort
  and permission pickers inside the card still return to their pill.

## Gotchas

- A popover's `onCloseAutoFocus` runs after its exit animation. A focus of the prompt from
  there, or a deferred one (`focusComposer`'s sequence + rAF), can land after the next
  popover opened and close it as a focus outside: the Add project list vanished right after
  a heading pick. The heading picker now focuses the prompt synchronously through a ref the
  card fills (`promptFocusRef`), and both it and `ComposerPicker` skip the late focus when
  something else (another popover's input) has the keyboard by then.
- In the e2e specs, press Escape after each Add project pick: the open list covers the pills
  below the card and Playwright refuses to click through it.
- `nogit.spec.ts` still expected the Project folder row to print the path; the shelf-polish
  PR had already removed it.

## Verification

`make check`; `e2e/project-sets.spec.ts` (Add project multi-select, Clear, workspace ×,
Run in on the right, prompt focus; `SHOTS=<dir>` writes the PR's screenshots),
`composer-switch.spec.ts` (single pick, Esc and click away to the prompt), plus the other
composer specs with Escape after Add project. Run on free ports beside another worktree's
e2e: `E2E_MOCK_PORT=7840 E2E_VITE_PORT=9280 pnpm exec playwright test e2e/project-sets.spec.ts`.
