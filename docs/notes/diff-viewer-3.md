# Diff viewer 3: view.panel.diff frames the tab

`view.panel.diff` gains `--base`, `--head`, repeatable `--path`, `--title`, `--note` and `--hide`
(`internal/command/commands_view_diff.go`). Calls with `--path` work as before, and `--scope` still
compares what it did, in a tab of its own.

## Decisions

- **There is no `--lock`.** `--hide compare` or `--hide files` are the only ways to reduce the
  controls, and `ModelBand` always offers Show controls, which stays shown once pressed. With
  everything hidden and no title or note the band still shows, so the way back never goes.
- **The checkout's own tab is the user's.** A thread may pick a file there, nothing more. Any
  call with `--base`, `--head`, `--scope`, a title, a note, `--hide`, several paths or a directory
  gets a tab of its own: the daemon sends a `thread` param, the asking thread, and the id includes
  it. The next untitled call updates that tab, and the same title updates its tab, as Gallery's
  does. A review found the first version writing `paths` to the own tab: "2 files" under the normal
  title, in a checkout with 7 changed. A second found `--base` and `--head` doing the same, which
  retitled the tab, changed its list and dropped its fold and commit state, with no band and no way
  back. So `--scope branch` moved too, and is the one old call that now opens a new tab.
- **A call with no sources only picks a file.** The intent keeps what the own tab compares,
  filters and folds, or a one-path call would have reset them. Anything without `thread` is that
  call in the intent, so a daemon from before this change, which sends `scope`, cannot move the
  user's tab either: until it restarts, its `--scope branch` picks the file and no more.
- **A side said aloud is a side.** `--base merge-base --head working` used to reach the tab as
  nothing, because a default stays out of the params, and returned success with the user's tab
  showing something else. It is `Given` that decides, so the call gets its tab, comparing what it
  said. A blank `--base=` is no side. The `From thread · …` title says whose it is; with no title,
  note, list or hide there is no band, as there is nothing to take back.
- **A tab says what happened and has a way back.** The band names the thread, and a narrowed list
  says "Listing only 2 paths" (the count: the list's totals are only of what was asked for).
  Show controls, or Show all files with nothing hidden, gives back the controls and the list; the
  note stays, with its own Dismiss, because pressing one should not lose what the other kept.
- **Model text never passes for the app.** As in `FileRequestBand`: the thread is named, the title
  sits inside that sentence in quotes, the note is a blockquote, all through `plainLine`.
- **One path keeps today's meaning:** that file, in the whole list. Two or more, or a directory,
  narrow the list. Nothing changes for an existing one-path call. A file that later leaves the
  list stays on screen and says so, as any file does (`docs/notes/diff-viewer-2.md`).
- **The checkout's root is every file.** `view.panel.diff .` lists everything, and among other
  paths it wins: narrowing to everything is no narrowing.
- **A path with nothing to show is a warning, and all of them a refusal.** Each one that matches
  no listed file is named on stderr and left out of `paths`, so "2 paths" stays true. The tab is
  still decided by what was asked: `a.go missing.go` is a narrowed list of one, not one file picked
  in the whole list. The daemon decides, not the verb: `fill` notes `unmatched_paths` while it has
  the whole list, before the cap and with the names it cannot list, since a capped list cannot tell
  "past the cap" from "no such file" and used to report a partial success. A `--title` that cleans
  down to nothing (or `--title ""`) is refused: it meant a tab of its own, and would have landed on
  the user's.
- **A title leads with the project on another checkout,** as untitled tabs do, so one title on two
  checkouts is two names. The band keeps the plain title.
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

So a value cannot hold a newline. The CLI refuses one by name (`argFlag.Set`, for any repeatable
flag or word). Another caller's value is split like any list, and a part that is no absolute path
is refused saying why. A repeatable positional has to be the last one (`Command.validate`).

## Skills

The routing row says `view.panel.diff [<path>…]`, names `--base` and `--head`, and points at the
verb's `--help` for `--title`, `--note` and `--hide`, because `<path>` alone read as one required
file. The rest is in that `--help`, which now shows `[<path>…]`. The generated guide had lost
`<path>` and `--hide`: `guideShowsArg` dropped every repeatable arg, which was meant for a plugin's
`--arg`, so it now drops that by name.

`make guide-eval MODEL=opus TASKS=p4-show-file,p9-show-images MAX_COST=3`, the two tasks on that
row: 6 of 6 chose the right verb, no invalid runs, $1.13 by the daemon's count ($0.86 in the runs).
The three wrong turns are `view.panel.gallery --help`, which the row itself points at. Neither task
asks for a diff, so `p10-show-diff` was added to measure that.

`make guide-eval MODEL=opus TASKS=p10-show-diff MAX_COST=3`: 3 of 3 ran `view.panel.diff` with
`--title` and `--note`, no invalid runs, $0.73 by the daemon's count ($0.46 in the runs). All three
read the verb's `--help` first, as the row says, which is the 3 wrong turns the report counts, and
none needed a second try. No budget or pin changed.

## Not done here

`GetWorktreeFileDiff` has no caller left in the app. It stays, as the API is append-only.
