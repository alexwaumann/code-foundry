# go-test red on the macOS runner

`go test -race ./...` failed on main and on pull requests with two tests that pass on a
Mac under any load.

## TestStoreRateLimitBudgetPauses: a real request during a pause

A poll that spends the budget set `pauseUntil` in `callDoc`, then carried on through the
rest of its cycle and reached `pollProjects`, which never looked at the pause. With a
repository tracked it sent `PollProjects` while paused. The test only tracks one after it
sees the viewer, so it needed `Track` to land between `applyViewer` and `pollProjects`.

The fix is in the product: `pollProjects` returns with the lists as they were while
paused, and the next poll, which waits the pause out, brings them.
`TestPollProjectsWaitsOutThePause` calls `Track` from inside the poll's own request, so
it fails every time without the check and needs no timing.

Not changed: a cycle's detail, failing-check and stats requests also run after the pause
starts. They were planned before the response that set it and are bounded by that plan.
