# Composer tags, PR 1: switch the composer's project from its heading

Status: branch `cf/composer-project-switch`. Frontend only, no daemon or proto change.
This is PR 1 of four. File and skill tags come in PR 3; this PR builds nothing for them.
Design: the static sketch in `/tmp/cf-composer/index.html` (`?h=a&t=a&pop=proj`),
`final-heading.png`, `h-a-open.png`.

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/lib/compose.ts` | `MovableDraft`, `movedDraft(draft, from, to, isGitRepo)`: the move rules (pure, table-tested) |
| `gui/frontend/src/stores/compose.ts` | `switchDraftTarget(from, to)`: move, confirm before replacing, select and focus |
| `gui/frontend/src/components/compose/ProjectRows.tsx` | `ProjectBadge`, project and workspace rows, `ProjectRowGroups` (moved out of ProjectPicker) |
| `gui/frontend/src/components/compose/useProjectRows.ts` | the row order both pickers use (workspaces by name, then projects) |
| `gui/frontend/src/components/compose/ProjectSwitcher.tsx` | the heading trigger and its popover |
| `gui/frontend/src/components/compose/{Composer,ProjectPicker}.tsx` | heading uses the switcher; Tab cycle moved up to include it; picker uses the shared rows |
| `gui/frontend/e2e/composer-switch.spec.ts` | mock e2e (4 cases × WebKit/Chromium) |

## Decisions

* **The trigger.** In `What should we build in <name>?` the name is a button. It has a
  1.5px dotted bottom border at `foreground/45`, which becomes full foreground on hover
  and while open. There is no chevron or pill. It has `aria-label="Change project"`,
  `aria-haspopup="dialog"` and `data-compose-stop`. Workspace composers show it too,
  with the workspace's name. It is disabled while a send is in flight.
* **Tab order.** `cycleStops` moved from the card to `composer-body`, so the heading is
  part of the cycle: name → member chips / "Also in…" → prompt → …. Shift+Tab from the
  chips reaches the name. The order is unchanged from the prompt onward.
* **The popover** is a Radix popover (`w-80`, centered under the name) around a cmdk
  list. The filter says "Switch project…". It has the same rows as cmd+N, with
  "Workspaces" above "Projects". There is no group heading when there are no
  workspaces. The cmd+1..9 hints are not shown. The current target is checked
  (`data-current`) and highlighted when the popover opens. The filter is cleared on
  every opening.
* **Shared rows, not copies.** The row markup lives in `ProjectRows.tsx` and the order in
  `useProjectRows`. ProjectPicker passes `soloHeading="New thread in…"` and
  `shortcuts`, so cmd+N renders as before. A row's cmdk value is its target's
  `draftKey` (repo id or `ws:<id>`), which matches the values the picker already used.
* **Move rules** (`movedDraft`):
  * Carried over: text, attachments, model, effort, permission, notice, phase.
  * Reset: worktree (a project gets `new`, a workspace gets `members`), base → null,
    error → null.
  * Also in: the old project is dropped and never demoted to Also in. If the new project
    was in Also in, it is removed (a swap). A workspace target, or a project with
    `git !== true`, gets no Also in.
  * Primary: kept only while it is still one of the moved draft's Also in projects,
    otherwise null.
  * PR 3's per-member cleanup (tags that name a project that is no longer a member)
    goes in one marked place in `movedDraft`.
* **`switchDraftTarget`:**
  * Same target or a busy draft: nothing happens.
  * If the target already has a non-empty draft, it asks first: "Replace the draft in
    <name>?" / "It has unsent text or images." / Replace, centered. Cancel changes
    nothing.
  * Otherwise it writes the moved draft under the new key and deletes the old key
    without revoking object URLs (the images moved). The replaced draft's URLs are
    revoked. It then selects the new composer the way `composeIn` /
    `composeInWorkspace` do (no `worktreePath` argument, so no worktree side effect)
    and focuses the prompt.
* **An empty draft moves nothing** (my call, beyond the brief). If the current draft has
  no text and no images and the target has a non-empty draft, the switch just shows the
  target's draft as it is, without a confirm. Overwriting typed text with an empty
  draft would lose work, and asking "Replace?" when there is nothing to move would be
  odd. The empty source draft is left in place.
* **Focus.** Esc returns focus to the trigger (Radix default). A pick prevents the
  popover's close-auto-focus. The new composer mounts (App keys Composer by target) and
  focuses its prompt. If nothing moved (same target, or the replace was cancelled),
  `focusComposer()` focuses the current prompt.

## Gotchas

* `react-refresh/only-export-components` rejects hooks and helpers exported from a
  `.tsx` file, which is why `useProjectRows` has its own `.ts` file.
* `ProjectRows.tsx` vs. a would-be `projectRows.ts` would collide on the
  case-insensitive macOS file system, which is why the hook file is named after the
  hook.
* In e2e, cmd+N from a prompt that has text does not open the picker. The spec clicks a
  sidebar thread row first, as `compose.spec.ts` does.
* React synthetic key events bubble out of the portalled popover into `composer-body`'s
  `cycleStops`. That is harmless: the filter input is not a stop, so the handler
  returns early.

## Verified

* Vitest: `movedDraft` has 16 table rows (one per rule) plus a no-mutation check.
  `switchDraftTarget` covers the move (URLs not revoked, old key deleted, selection,
  focus seq), a workspace target, same target / busy, confirm cancel then replace (via
  the real confirm store and `answerConfirm`; the replaced draft's URL is revoked), and
  an empty source draft.
* Playwright (`composer-switch.spec.ts`, WebKit + Chromium):
  * Switch code-foundry → ghostty-playground with ghostty in Also in: the heading
    follows, text and model are kept, Also in is empty, the prompt has focus, and
    `session.new` gets `repo: repo-gp` with no `repos`. Code-foundry's composer is empty
    afterwards.
  * Switch to a workspace: the chips show its members, Also in is gone, the worktree
    shows "Workspace worktrees". Then from the workspace composer to dotfiles.
  * Shift+Tab reaches the trigger. Enter and Space open it. Esc closes it and focus is
    back on the trigger. Picking the current project just closes it.
  * The replace confirm: cancel keeps both drafts; Replace moves the draft.
* Screenshots (dark, mock) checked against the sketch.
* `make check`, `make gui-e2e`, `make gui-build` (see the PR).

## Daemon restart

Not needed: no daemon change.
