# Leads (children that orchestrate)

For the code-foundry-orchestrate skill: how a parent makes a child a lead, and the rules
the lead follows.

- To make a child a lead, tell it in its prompt "You are a lead: use the
  code-foundry-orchestrate skill" rather than copying these rules into the prompt. A
  lead only coordinates: give it no new worktree. It never runs `project worktree
  cleanup`: its parent owns it.
- Before a lead ends a turn while its workers still run, it posts `code-foundry thread
  report progress "<n> workers started: <ids>"` (with the ids its `thread new` calls
  printed); without it the parent is woken with "finished" and no report. That settle
  does not wake the parent: the daemon holds it while workers run and wakes the parent
  when the lead's work is done or a worker needs someone. A lead's wake counts its
  `children` ("2 of its 3 child threads still working": not done). Its final report
  lists each worker's id, branch, status and every concern a worker raised; a parent
  runs `thread reports --descendants-of <lead>` (with costs) before presenting it.
