# Tooltip pruning and fixes

A pass over the GUI's tooltips against the rule in CLAUDE.md: a tooltip only shows what is
hidden (an icon-only control's name, information not on screen, text that is cut off).

## Removed or made conditional

- Theme card Undo of the card's own colours: no tooltip (`themeUndoState` returns `tip: null`
  for it). "Back to <name>", Undone and the gone state keep theirs.
- A patch file row's path: plain `whenTruncated`. `truncated()` looks at descendants, so a
  rename (old path → new path) opens only when one of its parts is cut.
- The PR diff's file header: `FileHeader` takes `whenTruncated`; only `PrDiffView` passes it,
  and only for a file that was not renamed (its path is what the row shows). The File and
  Diff tabs keep the hidden absolute path.
- A composer file tag at the project's root (`README.md`): no tooltip, since the path is the
  label (`fileTagTip` in tagContext.ts). `TextTag` leaves out its `TooltipContent` rather than
  changing the trigger, so the node view is not remounted.
- A plugin link whose text is its URL: no tooltip (the `showsTarget` rule of pr/Markdown.tsx).
- Ember's task pointer: no "Open on the board"; a cut title or branch shows in full instead.
- Publish picker: Public and Private lose their tooltips (the label says it); Internal keeps
  its gloss. `RadioGroupChoice` is styled from `aria-checked`, so the `Tip` around it is safe.
- The Needs-you stepper's current dot: no tooltip (the popup shows that request).
- ThreadComposer: Send and Attach have no tooltip while disabled; neither name says why.
  Composer.tsx keeps its "Pick a project first".

## Broken tooltips fixed

- Project Refresh: a span carries the tooltip, so "Refreshing…" shows while the button is
  disabled.
- Mermaid's "Diagram not drawn" note: a one-line message now shows when the line is cut.
- Workspace folder row: the red "missing" is inside the trigger; the tooltip says what to do
  in words, not with the `workspace set-root` verb.
- Attachment chips (composer and sent): a name `middleTruncate` cut shows in full; a sent
  chip whose file is gone says it cannot be opened (`attachmentChipTip`, lib/compose.ts). The
  sent chip's tooltip sits on a span, because the gone chip is a disabled button.
- A subagent's read-only card leaves "Restart Claude" out of the plugin environment note
  (`envStaleTip(change, false)`): it has no thread menu.
- Needs popup title: falls back to the thread id like the title does.
- Dictation's listening pill: "Stop dictating", its accessible name.
- PR checks: "name · workflow" over the description (`checkTip`).

## Copy

- "Show only this space" / "Show all spaces"; "Close" (Usage); "1 commit" / "N commits";
  "1 merged PR" / "N merged PRs" (`seriesUnit`); "Partially parsed: …"; "Show page" /
  "Show source"; "Open tab"; "Can’t collapse the last open pane"; "Stop waiting for this"
  (not "Stop waiting", the thread-wide command); "Close editor"; "Delete file"; "Open in…"
  (the ellipsis's accessible name stays "Open in options"); a constant "Wrap lines" (the
  pressed state shows on and off); "Available in the desktop app".
- "Open pane" → "Expand pane": `useNamed` only appends pane.collapse's chord to the words it
  is given; the command's title is "Toggle Collapse Pane", so the words were not a title.
- Ember's Copy answer and a turn's Copy reply both copy an assistant reply: both are now
  "Copy reply".

## Tests

Vitest only. The e2e specs that asserted old copy were updated (Usage close, Open tab,
Copy reply comments), and theme-model-flow's hover of the own-colours Undo was dropped
(themeCards.test.ts covers it).
