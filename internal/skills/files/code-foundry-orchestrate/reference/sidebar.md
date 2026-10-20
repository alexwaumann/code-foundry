# Which threads the user sees

For the code-foundry-orchestrate skill: the sidebar, handing a thread over, and what
archiving takes along.

## Hidden by default

A thread you create (`thread new`, whose `--created-by` defaults to you) is yours to
manage, not the user's: it stays out of the app's sidebar and out of the Dock badge, so
its questions and finished turns do not reach the user there. The user still finds it in
your thread's Threads tab (the panel lists every thread you created). A thread the user
creates is always shown. The user's setting `threads.show_created_threads` (default off)
shows every created thread; a thread's own override wins over the setting either way.

So while a child is hidden, you are the one who answers it: watch its wakes, answer its
prompts (`reference/wakes.md`), and tell the user what it did.

## The override

- `code-foundry thread sidebar --id <child> --shown=true`: show it in the sidebar. The
  user now manages it: it counts in the Dock badge and stays when you are archived.
- `code-foundry thread sidebar --id <child> --shown=false`: hide it again.
- `code-foundry thread new ... --sidebar`: create it shown from the start (only for a
  thread you create; `--sidebar=false` creates it hidden even when the setting shows
  created threads).
- `thread list` marks an override `[in sidebar]` or `[hidden]`; `--json` has
  `inSidebar` (absent: the setting decides). On a thread the user created the command
  refuses (exit 2).

## Handing over

Create hidden, drive it, and hand it to the user when they should take over: a child
whose work the user will review, steer or merge themselves, or one blocked on a decision
only the user can make. Then `code-foundry thread unsubscribe --thread <child>`: the
user's steers are not yours to act on, and each would wake you. Say so when you do ("I
handed <name> (<id>) to you; it is in your sidebar; I no longer follow it"). A thread
you handed over is the user's: archive it only when they name it, and say when you left
it out ("archive everything" means your hidden children). The reverse: when the user
asks you to take a thread back, or a shown child turns out to be routine, hide it
(`--shown=false`), subscribe again (`thread subscribe --thread <child> --repeat`) and
keep driving it.

## Archiving takes hidden threads along

`thread archive` on a thread also archives every hidden thread below it (its children,
theirs, and so on), first and the same way: their Claude stops, their shells go. It
stops at a shown thread: that thread and everything below it stay, as the user manages
them. Unarchiving brings back only the thread named. When a hidden thread below is still
working or waiting on an answer, the archive asks first (exit 2 without `--yes`); to
keep one, hand it over before you archive. `--descendants-of` and `--ids` archive
exactly the threads they name, shown ones included.
