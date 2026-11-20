# Confirm labels and confirmation copy (2026-11-19)

PR 5 of the messaging and settings overhaul: the Go side of confirmations. The GUI dialogs
and `bridgeHost.ts` are a parallel PR; `commands_dictation.go` is another.

## What changed

* **Every built-in command with `Confirm` sets `ConfirmLabel`**, a sentence-case verb of one
  or two words (`Archive`, `Remove`, `Delete`, `Kill`, `Clean up`, `Turn on`, ...). Without
  one the GUI's button said the title: thread.archive's read "Archive or Unarchive Thread".
  `TestConfirmingCommandsHaveLabels` walks the whole registry (`all.Register`) and fails on
  a confirming command with no label or a label not in sentence case. Titles stay in title
  case: the palette and the Help menu show them. pr.close keeps "Close pull request" (GitHub's
  button's words, chosen before).
* **`Command.DynamicConfirmLabel`** replaces `ConfirmLabel` at invoke time when it returns
  something; registering it without `ConfirmLabel` is refused. app.restart uses it: "Install
  and restart" with an update downloaded, as its `DynamicTitle` does. The plugin install
  question only comes with `--enable`, so a static "Install" was enough there.
* **Run-time `ConfirmError`s carry labels too**: the uncommitted-work second stage says
  `Delete` (its title stays "Delete Uncommitted Work"); ember.enable's page question says
  "Turn on" (was "Turn On").
* **Names, not ids.** thread.remove names each thread (`threadNameOrID`, one list call, an id
  the daemon does not list stays an id); project.unregister, project.delete,
  project.branch.delete and project.worktree.cleanup's fallback name the project through
  `Registry.projectNamer` (the id when unknown); terminal.kill names the terminal by its title
  label, its action's name or its running job, quoted, else the id. The tab's manual name
  lives only in the GUI's layout, so the daemon cannot use it.
* **Copy.** project.unregister: "Remove project {name} from Code Foundry? Nothing else on disk
  is deleted: only clean worktrees Code Foundry made that no thread uses (branches stay). Its
  threads lose their worktree." pr.revert asks a question naming the repository.
  thread.stop-waiting: "Its other waits end too".

## Verified before writing

* **What thread.remove deletes.** `thread.Manager.Remove` closes Claude, removes the thread's
  shells, stops its strays and TMPDIR, retires its usage into the retired ledger and deletes
  its `threads` row; `thread_items` (the conversation) and the other per-thread tables cascade
  on that delete. Claude Code's own transcript file is not touched, so the copy says "the
  thread is deleted with its conversation and terminals", not that every trace goes.
* **Can a hidden child be forked from the GUI?** Yes. A hidden child is out of the sidebar
  but open from its creator's lineage group (thread info), the worker card and the palette
  (`docs/notes/no-sidebar-override-1-gui.md`); the thread menu's Fork
  (`ThreadMenuItems.tsx`) and the palette's Fork Thread (thread.fork, `When: hasThread`) run
  on it. So `forkToKeep` now says "fork it first (Fork Thread)." The same text is the CLI's
  prompt; an agent's guide still names `thread fork --id <id>`.

## Gotchas

* Project id args are resolved before the question (`ProjectID` ref resolver), so the
  confirm sees an id even when the user typed a name; `projectNamer` maps it back.
* The frontend mock (`gui/frontend/mock/*`, `src/test/prWorld.ts`) has its own copies of
  some of these questions. They are left for the frontend PR: this one touches Go only.
