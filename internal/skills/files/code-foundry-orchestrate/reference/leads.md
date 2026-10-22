# Leads (children that orchestrate)

{{cf.provenance}}

For the code-foundry-orchestrate skill: how a parent makes a child a lead, and the rules
the lead follows.

- To make a child a lead, tell it in its prompt "You are a lead: use the
  code-foundry-orchestrate skill and read its reference/leads.md first; finish with
  `code-foundry thread report done` listing each worker" rather than copying these rules
  into the prompt. A lead only coordinates: give it no new worktree. It never runs
  `project worktree cleanup`: its parent owns it.
- A lead starts its workers within its first few tool calls: it reads only what it needs
  to write their prompts, plans at the file level (who owns which file, which pieces
  stack with `--base`, plus `--base-from-origin no` while that branch is not pushed),
  never at the line level, and runs no experiments. Conflicts found later are
  reported, not prevented: never promise a parent conflict-free branches.
- Each worker's branch delivers its whole piece on its own. When two pieces must change
  the same code, stack them (`--base`) or let them conflict and say so in the first
  progress report; never move part of one piece into another's branch, unless the
  parent said to.
- A lead that needs scratch files (prompt drafts, notes) writes them under `$TMPDIR`,
  never in the skills directory or the project checkout.
- Before a lead ends a turn while its workers still run, it posts `code-foundry thread
  report progress "<n> workers started: <ids>"` (with the ids its `thread new` calls
  printed), so its parent's `thread reports` shows where it stands. No settle of a lead
  wakes its parent while a worker runs, report or not: the daemon wakes the parent once
  the team settled, or at once for the lead's own question, error, budget stop or
  done/failed/blocked report. A worker's prompt or question wakes the lead, which
  answers it (`reference/wakes.md`); the parent hears of it only through the lead. A
  parent's wake about a lead counts its `children` ("2 of its 3 child threads still
  working": not done). The lead's LAST step is `code-foundry thread report done` listing
  each worker's id, branch, status and every concern a worker raised, earlier rounds
  included (a new report replaces the old); a parent runs `thread reports
  --descendants-of <lead>` (with costs) before presenting it, and quotes cost from
  `thread list --descendants-of $CODE_FOUNDRY_THREAD` (the whole tree, itself included).
  A follow-up on a piece a lead ran goes to that piece's worker (`thread send`; the
  lead's report or `thread list --descendants-of <lead>` names it), not to a new thread.
