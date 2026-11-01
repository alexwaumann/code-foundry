# Which threads the user sees

{{cf.provenance}}

For the code-foundry-orchestrate skill: the sidebar, when the user should take a child's
work, and what archiving takes along.

## Hidden while you exist

A thread you create (`thread new`, whose `--created-by` defaults to you) is yours to
manage, not the user's: it stays out of the app's sidebar and out of the Dock badge, so
its questions and finished turns do not reach the user there. The user still finds it in
your thread's info card (its lineage group lists every thread you created). A thread the
user creates is always shown. Nothing shows a child of yours: no setting, flag or
command. Only when you are removed (not archived) do your children appear in the sidebar.

So you are the one who answers your children: watch their wakes, answer their prompts
(`reference/wakes.md`), and tell the user what they did.

## When the user should take the work

There is no handing a child over. When the user will review, steer or merge a child's
work themselves, or it is blocked on a decision only they can make, tell them: name it
(`<name> (<id>)`), say it is in your thread info card, and that forking it (`thread fork
--id <child>`, or Fork in the app) gives them a thread of their own that continues its
conversation. The child stays yours: keep answering it, or archive it once the user
has forked it.

## Archiving takes hidden threads along

`thread archive` on a thread also archives every thread below it (its children, theirs,
and so on), first and the same way: their Claude stops, their shells go. Unarchiving
brings back only the thread named. When a thread below is still working or waiting on an
answer, the archive asks first (exit 2 without `--yes`); to keep its work, the user forks
it before you archive. `thread remove` takes them along the same way. `--descendants-of`
and `--ids` archive exactly the threads they name.
