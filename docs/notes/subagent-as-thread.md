# A subagent renders like a thread (2026-11-05)

A subagent's page had its own header, footer and dashed plate, and no info card, so moving
between a thread and one of its runs changed the whole pane. It now draws as a child thread
does, without anything that acts on the thread. Frontend and mock only.

## What changed

* **Header**: `ThreadCrumb` (exported, with a `run` prop) then the Bot and the run's name, and
  `HeaderActions`' three toggles. No back arrow, Read-only chip or status.
* **Turn header**: `rows.tsx` split `LiveTurnHead` and `TurnHead` out of `HeaderRow`; the run's
  head uses them with `headerParts`. The footer is gone. Above the work, like a turn.
* **Fold**: the run's choice is in the thread's turn folds under `run:<id>`, so it is kept for
  the visit and forgotten on leaving the thread, as a turn's is. Finished folds by default.
  Folded keeps what it answered: its last text, or its report when that is a different text.
  A failed run's error stays in view folded, under the red header.
* **Card**: `ThreadInfoContent` with a `runId`, inline and as the overlay, by the same
  `threadInfoOpen` and `useCardRoom` state (`useInfoRoom` is shared with `ThreadPane`).
* **Composer**: `SubagentComposer`, a `.ccard` the same size as the thread's (an e2e compares
  the boxes). It has no draft, drop target or editor.

## Read-only: what is out

| Where | Left out | Why |
| --- | --- | --- |
| Crumb | Move picker of a no-project thread | It moves the thread |
| Header | Title menu | No thread actions |
| Place | Project row's menu (Add project, Run in, Save or Use workspace), Action row | They change the thread or run on it |
| Git | Git state row (Push, Pull, Rebase, Fix, Resolve) | They act on the checkout or send a prompt. Ahead and behind stay on the branch row |
| Lineage | The label's menu, the stop square, opening a row | A run's own runs have no view (depth 2) |
| Card | Shells, MCP, Actions | The thread's, not the run's |

Commands: `notInSubagent` in `keys/bindings.ts` is checked by `isStartable`, the one gate of
the palette, chords and command buttons. It holds the title menu's verbs, the composer's
pickers and Interrupt, `git.push`, `git.pull` and `composer.history`. It is a GUI rule, not a
daemon `When`: the sidebar row's menu sends the same verbs with the same context and must keep
working, as the thread is still selected and that row names it. So no daemon change.

## Aimed at a composer

No `ThreadComposer` is mounted, so each of these has no target. Tested in
`SubagentPane.test.tsx`.

* **File drops**: no `data-file-drop-target` in the pane.
* **Dictation**: no target, so `dictation.toggle` is false and the daemon is told there is no
  composer. The hold key then takes its system path, which pastes at the caret; the view has
  no field, so nothing lands, and a bottom shell with the keyboard still gets it.
* **@-tags**: no cite target, so `insertTagInto` is false. `file.find` is already off here.
* **Up**: no editor. **`composer.history`**: off in the palette, and its presenter does
  nothing here, which also covers the CLI's through ShowView. A panel's own composer with the
  keyboard still opens its picker from Up.
* **Focus requests** (`promptFocusSeq`, `contentFocusSeq`): the view takes the keyboard, so
  Escape keeps working after a palette or a sidebar Escape.
* **`composer.stage`**: unchanged. The text waits in the parent's draft and shows on going up.
* **Ask Claude on a page's errors** is a click aimed at the parent's prompt: it goes up, or
  the click would seem to do nothing.

## Gotchas

* The key dispatcher listens on the window before the overlay does, so Escape closed the
  overlay and also went up. `chordFires` now gives a bare Escape to an open overlay.
* Context is the run's latest request against the *thread's* window. The GUI has no window per
  model, so a run on a smaller model reads low.
* The parent row's word is the thread's own status, as a child thread's card has it: a parent
  idle while its background runs work says Done.
* `Thread.agent_runs` and `ThreadAgentRun` share Claude's agent id. A run the list does not
  have yet shows the card's empty Usage.
* Find is unchanged: `thread.find` stays off in this view. Only the bubble's label selector
  left `findDom.ts`, with the label.
