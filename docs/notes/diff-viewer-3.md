# Diff viewer 3: view.panel.diff frames the tab

`view.panel.diff` gains `--base`, `--head`, repeatable `--path`, `--title`, `--note` and `--hide`
(`internal/command/commands_view_diff.go`). Calls with `--path` and `--scope` work as before.

## Decisions

- **There is no `--lock`.** `--hide compare` or `--hide files` are the only ways to reduce the
  controls, and `ModelBand` always offers Show controls, which stays shown once pressed. With
  everything hidden and no title or note the band still shows, so the way back never goes.
- **One path keeps today's meaning:** that file, in the whole list. Two or more, or a directory,
  narrow the list. Nothing changes for an existing one-path call. A file that later leaves the
  list stays on screen and says so, as any file does (`docs/notes/diff-viewer-2.md`).
- **A titled tab has its own id.** A thread can never take over the tab the user is working in,
  and the same title updates the same tab, as Gallery's does. Without a title the checkout's
  own tab is used.
- **The check is the tab's own read.** It moved from `GetWorktreeFileDiff` to `CompareWorktree`,
  so a call that would show nothing fails, with the old messages for the old calls. A rename's
  source now comes with it, which the old verb never passed.
- **Refs are not checked here.** The daemon is the boundary (`docs/notes/diff-viewer-1.md`).
  `--base working` is the working tree; a branch called `working` needs `refs/heads/working`.
- **`--scope` with `--base` or `--head` is refused**, as the two say the same thing.

## Several checkouts

A path resolves to the deepest of the thread's checkouts holding it (`Thread.checkout_paths`), so
a sibling's file opens that checkout's tab. Paths in two checkouts are refused, naming both: one
tab shows one checkout. No path is the thread's own checkout.

## Repeatable paths

`ArgSpec.Repeatable` allowed only non-positional strings. It now also allows a path, positional or
not, and a repeatable positional takes every bare word, after what its flag set:
`view.panel.diff a.go b.go --path c.go`. Each value resolves on its own, in the CLI (`absPaths`,
against its cwd) and in the daemon (`parse`, `ExpandPath`). They travel joined by newlines, as
repeatable values always have. Live testing found the bare-word case: without that, a second
word was "unexpected arguments".

## Skills

The routing row says `view.panel.diff [<path>…]` and names `--base` and `--head`, because `<path>`
alone read as one required file. The rest is in the verb's `--help`.

`make guide-eval MODEL=opus TASKS=p4-show-file,p9-show-images MAX_COST=3`, the two tasks on that
row: 6 of 6 chose the right verb, no invalid runs, $1.13 by the daemon's count ($0.86 in the runs).
The three wrong turns are `view.panel.gallery --help`, which the row itself points at. Neither task
asks for a diff, so this shows the row still routes, not that agents find `--base`. No budget or
pin changed.

## Not done here

`GetWorktreeFileDiff` has no caller left in the app. It stays, as the API is append-only.
