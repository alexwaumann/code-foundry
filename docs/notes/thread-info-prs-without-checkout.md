# Thread info card: pull requests without a checkout

Status: done on branch `fix/archived-thread-info-prs` (GUI only).

A user opened an archived thread: the sidebar's hover card listed two pull requests, the
thread info card none. It looked like the card needed a connected Claude. It does not.

## Why

An archive removes the worktrees the app made for the thread when they are clean and
nothing else holds them (`internal/daemon/cleanup_archived.go`). `GitGroup` returned
nothing without the cwd's checkout, and the pull request rows lived inside it. The rows
need only the thread's own links, which never go. The hover card reads those links
directly, so it kept them.

The same gate hid a child's pull requests on a thread in a folder without git, or with no
project at all.

The only row the card gates on the connection is MCP (`McpGroup`), and rightly: a stopped
Claude has no MCP servers.

## What changed

* `GitGroup` keeps the checkout gate on the rows that need one (branch, git state,
  Changes) and shows the pull requests either way. With neither it is absent, so closed
  pull requests alone leave no empty group and no stray divider.
* The card reads each pull request through `useLinkedPrViews`, split out of
  `useLinkedPrFacts`: the freshest of the detail, the dashboard and any branch list. A
  detail that cannot be read no longer drops a row the sidebar still shows.

## Decisions

* A pull request nobody has read yet stays off the card, where the hover card shows a bare
  `#123`. A card row's second line needs a state and checks.
* No branch row after cleanup. The thread records a branch, but the row reads ahead,
  behind and upstream from a checkout that is gone.

## Gotchas

* `Open in Finder` and the action row still show on a cleaned-up thread: `PlaceGroup`
  gates on the recorded path, not on the checkout. Left alone here.
* The mock's `thread-info?scenario=archived` keeps the single scenario's running subagents,
  so its Lineage says "2 running". A real archive ends them.
