# Ticking a description's task boxes: the daemon

`pr.checkbox` (`GhService.SetPullRequestCheckbox`, `internal/store/gh/pr_checkbox.go`) ticks
or unticks one task-list item of a pull request's description. Descriptions only: comments and
reviews stay read-only.

## Decisions

- **The fresh copy decides.** GitHub has no compare-and-set for a body, so the box is flipped
  in a copy read right before the write (`pull_request_body.graphql`: id and body, not the whole
  detail), never in the cached detail. Every edit made since the client looked is kept, as long
  as the item itself still reads the same.
- **Item identity is index plus text.** The client sends the Nth item and its first source line
  after the box. A different line at that index, or no such index, is refused with
  FAILED_PRECONDITION and the detail is invalidated, so the client shows the new text. Text is
  source, not rendered: both sides can slice it, and no markdown has to agree on what it renders.
- **Requested state, not a toggle.** The call says ticked or unticked. A box already so sends no
  mutation and succeeds (`changed` false), so a click racing someone else's tick is not undone.
- **One at a time per pull request.** The read and the write hold `mergeLocks` for that pull
  request, so a second click reads the first one's result. Its own lock was not worth having: a
  merge holds it for seconds and a description edit can wait for that.
- **Merged and closed are not refused.** GitHub lets whoever can edit do so; its refusal is
  relayed (`writeRefused`, FORBIDDEN is PERMISSION_DENIED).
- `pr.checkbox` takes `--index`, `--checked` (`--checked=false` to untick) and `--text`. `text`
  is optional only because an item may have nothing on its line (`- [ ]` over a continuation);
  left out, it must match that empty line. NoPalette: it names an item only a page can show.

## What counts as a task item

`internal/store/gh/task_items.go` parses with goldmark (plus Table and Footnote, which change
block structure) and applies micromark's rule itself rather than goldmark's TaskList, which is
looser (`- [ ]foo` is a box to it, not to GitHub or the GUI). `testdata/task_items.json` is
checked by both sides' tests.

Nothing but the one byte inside the box changes: the offset comes from the paragraph's first
line segment, which is a position in the original bytes, so CRLF and trailing spaces survive.

## Gotchas

- An edit landing between the read and the write is lost. GitHub offers nothing to close that
  window; it is two requests wide.
- goldmark and micromark were compared on 120,000 generated bodies during the build. Two things
  still differ, both left alone: a `|---|---|` row straight under a list line without a matching
  header (goldmark makes a table of it) and an ordered list not starting at 1 straight after
  indented code (micromark sees no list). A tab inside the box is refused by both on purpose:
  micromark takes it only where the tab happens to be one column wide. A difference shifts the
  index, and the text check turns that into a refusal instead of a wrong tick, unless the two
  items read the same.
- A task item in a footnote is left out on both sides: it renders apart from where it is
  written, and only when referenced.
