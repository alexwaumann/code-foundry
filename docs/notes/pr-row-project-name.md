# Pull request rows name their project in a multi-project thread

The thread info card's pull request rows (`prRows` in `gui/frontend/src/lib/threadInfo.ts`,
`PrRowView` in `components/threadinfo/GitGroup.tsx`) named a pull request's project on a
sub line except for the cwd's project, whose rows had none. A user with threads over
several projects had to look up at the working directory to work out which project the
unlabelled rows were for.

## Decisions

* **Several projects: every row is named**, the cwd's project's included. "Several" is the
  thread's set having more than one member, named workspace or unnamed set alike: the
  same `members.length > 1` the Changes row folds on.
* **One look.** The cwd's project's name is the same muted sub line as every other; no
  colour or mark tells it apart (its rows already come first).
* **One project: unchanged.** No project line for its own pull requests.
* **Other repositories** (no member has the slug) keep their slug, in both cases.
* Order unchanged: the cwd's project first, then the set's order, then other repositories.

## Gotchas

* `prRows` already took the set as `memberOrder` (the cwd's project first), so it derives
  "several" from its length and stays pure; no new argument. `useMembers`'s `members` is
  `useThreadCheckouts`'s `projectIds`, which holds the cwd's project alone for a thread
  with no recorded set, so a single-project thread counts one.
* No e2e asserted the project line; the vitest tests for `prRows` and the card's ws9 case
  carry the rule.
