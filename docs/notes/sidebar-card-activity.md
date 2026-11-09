# Thread card: what a running thread is doing

Since the title-first rows (docs/notes/sidebar-title-first.md) line 3 is always the branch, so
two things the row used to say were nowhere: the tool a working turn runs, and the step a setup
is on. The row's hover card now says them, right under the name (`TipActivity` in
`SidebarRow.tsx`):

- **Working · `<tool>`**: `Thread.busy_tool` through `statusDetail`, in the code role. While
  Claude compacts, "Working · compacting" in plain text.
- **Setting up · <step>**: the setup's current step ("Fetching origin/main"), plain text.

The icon is the row's dashed circle in the info tone, and so is the word; the separator is
muted, like the other status lines' times. The text wraps and is cut after three lines, so a
long Bash command never makes a tall card.

No line for a turn with no tool yet ("Working" alone would repeat the row's icon), for a thread
waiting on its children (TipWaiting says that), or for any other status (TipStatus has the
attention, error and done ones). Everything else the row dropped was already on the card: the
question, permission, plan, error and flag texts (TipStatus) and a queued move (TipMoving).
