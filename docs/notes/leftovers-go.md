# Go leftovers: merge in flight, kept TOML, fixed-count patterns, flood timer

Four small fixes, one commit each.

## 1. A merge that arrives while one is in flight (internal/store/gh/pr_merge.go)

The per-pull-request lock (`mergeLocks`) is held by the caller, so it already serialized
two callers that both waited. The gap was a first caller that left (its context ended)
while its merge job still ran on the worker: the lock was free, the memo not written yet,
and a retry queued a second mutation, which GitHub refused ("Pull Request is not
mergeable") for a merge that succeeded.

Decision: no new waiting. The worker runs one job at a time, so a merge job queued behind
the one in flight starts only after that one has written its memo. The job checks the memo
first and answers from it. The caller's refusal path (cached state says not mergeable, so
it refetches) checks the memo after the refetch for the same reason: the fetch job ran
after the merge job. Keeping the lock until the job ends was the alternative. It was
dropped because a queued job that never runs (the store stops) would hold the lock for good.

Test: `TestMergePullRequestWhileInFlight`, merged and outcome-unknown rows: the first
caller leaves mid-mutation, a retry is queued while the mutation is blocked, a third joins,
and one mutation goes out.

## 2. Unknown settings with structured TOML values (internal/store/settings/file.go)

Raw values stay `map[string]string`. An unknown key whose value is not a scalar or a list of
scalars (an array of tables, a table in a list, a date or time) holds `"\x00toml:" +` the
value as inline TOML. `encodeLiteral` writes that text back as it is. `[[x]]` comes back as
`x = [{...}]` (same meaning, inline), and keys inside inline tables are sorted. Known keys
(fields, keybindings, moved keys) keep the old stringified text, because a string field
would otherwise accept the marker as its value. Their validation reports the bad value as
before.

Gotcha: BurntSushi marks TOML's local date-time, date and time by location name
(`datetime-local`, `date-local`, `time-local`; the package is internal). Its own encoder
shifts them to UTC, so the inline writer formats them in their own location.

## 3. Fixed count over an unbounded group (pluginsdk/ui/validate.go)

`(a+){30}` is now refused, along with any fixed count n > 1 (`{n}` or `{n,n}`) on a group
that holds `+`, `*` or `{n,}`. A group holding only bounded quantifiers keeps passing
(`([0-9]{1,3}\.){3}`). `repeats` now treats `{n,n}` like `{n}` (a fixed count). So
`(a{1,3}){2,2}` passes like `(a{1,3}){2}`, and `(a+){2,2}` is still refused by the new rule.
A count too large for an int reads as `math.MaxInt`. The plugin skill's forms reference
says so. This reaches plugin authors with the next pluginsdk tag. The daemon refuses these
views as soon as it is rebuilt.

## 4. Flood warning on a silent surface (internal/store/plugin/surface.go)

A timer (`instance.flood`) is armed when a surface becomes throttled. It fires
`FloodQuiet` (new option, default a minute) after the last flooding second. If a flooding
second came since, it re-arms for the rest. Otherwise it lifts the throttle, logs the
"back under" line and clears the issue. The on-arrival check in `countLocked` stays and
stops the timer. The callback compares `in.flood` with its own timer under `in.mu`, so a
timer that was stopped or replaced does nothing. The timer is stopped when the instance
leaves the hub (context-gone close, eviction) and when the hub closes. A host close that
keeps the instance does not stop it, because a closed surface sends no view that would
clear its warning.

Test gotcha: the store clock is the test's skewed `Now`, but the timer is real time. The
test's `FloodQuiet` (1.5 s) is longer than one clock step (1 s), so the timer cannot lift
the throttle mid-flood however slow an act is under load.

Not changed: an instance deleted while throttled leaves its surface's flood issue up until
that surface floods and recovers again or the plugin is removed. The issue is per surface,
not per instance.
