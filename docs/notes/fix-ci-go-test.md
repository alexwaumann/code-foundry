# go-test red on the macOS runner

`go test -race ./...` failed on main and on pull requests with two tests that pass on a
Mac under any load. A draft pull request ran temporary diagnostics on the runner
(run 41751469996, macos-26-arm64); the numbers below are from it.

## TestRunPortsLive: the test's server, not the probe

The test was wrong and the probe is right. `python3 -m http.server` calls
`socket.getfqdn(host)` in `server_bind`, before `server_activate` calls `listen()`. On
the runner `getfqdn('127.0.0.1')` took 35.03 s and 35.02 s (4 ms on a Mac) and then
answered `localhost`, so the server sat bound and not listening well past `waitPorts`'
10 seconds.

Watching the same run for 60 seconds showed it. The run stayed running, so it had not
exited early, with no output. Each probe took 12 to 54 ms. lsof showed the socket as
`TCP 127.0.0.1:49184 (CLOSED)` in 36 samples, then `(LISTEN)` in the sample at 36.2 s,
and `ListeningUnder` found the port in that same sample. The probe reports a port once
something listens on it and no sooner, which is what a user wants.

Ruled out: the login shell (`/bin/sh -lc` found `/usr/local/bin/python3`, 3.14, not the
`/opt/homebrew/bin/python3` of the test's PATH, and it ran), and sysctl and `treeGroups`
(they found the port).

The test now runs a small `python3 -c` listener that binds and listens at once: still a
real process under `<shell> -lc`, and the port still has to go with the run. Why the
reverse lookup takes 35 s on the runner was not looked into; only the time was measured.

## TestStoreRateLimitBudgetPauses: a real request during a pause

A poll that spends the budget set `pauseUntil` in `callDoc`, then carried on through the
rest of its cycle and reached `pollProjects`, which never looked at the pause. With a
repository tracked it sent `PollProjects` while paused. The test only tracks one after it
sees the viewer, so it needed `Track` to land between `applyViewer` and `pollProjects`.

Confirmed on the runner: 5 of 30 runs of the test failed, the extra request was
`PollProjects` every time, and `Track` had returned 16 to 22 ms before it started. Its
only repository is the one the test tracks and no repository means no request, so the
tracked list was read after `Track`.

Inferred, not measured: why the runner hits this window and a Mac does not (40 local runs
passed). The window runs from the viewer's publication to `pollProjects` reading the
tracked list, with the poll's cache writes inside it, and the test looks for the viewer
every 5 ms; slower writes on the runner are a guess. The window was never timed, on
either machine.

The failure is intermittent: the same run's `go test ./internal/store/gh` passed without
the fix. So one green `go-test` says little about it. The test below is the proof.

The fix is in the product: `pollProjects` returns with the lists as they were while
paused, and the next poll, which waits the pause out, brings them.
`TestPollProjectsWaitsOutThePause` calls `Track` from inside the poll's own request, so
it fails every time without the check and needs no timing.

Not changed: a cycle's detail, failing-check and stats requests also run after the pause
starts. They were planned before the response that set it and are bounded by that plan.
