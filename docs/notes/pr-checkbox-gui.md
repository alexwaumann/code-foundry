# Ticking a description's task boxes: the GUI

The description's task boxes run `pr.checkbox` (docs/notes/pr-checkbox.md). Only the description,
only when `viewerCanUpdate`, in any pull request state, as on GitHub. Thread messages, comments,
file previews and plugin markdown keep their disabled `<input>`: `MarkdownExtras.task` is opt-in.

## Decisions

- **Which `<input>` is a task item.** Rendering cannot tell: raw `<input type="checkbox">`, and
  raw `<li class="task-list-item">`, come out of rehype-raw and the sanitizer looking just like
  remark's. So `lib/taskItems` numbers items on the mdast (`typeof checked === "boolean"`, first
  block a paragraph, box in the source) and a rehype pass moves the number to remark's `<input>`
  **before** rehype-raw, while raw HTML is still text. The number carries a per-load random mark,
  so a body cannot write the attribute itself. Those two attributes are allowed only in the
  sanitizer schema this surface uses.
- **Agreement with the daemon is one fixture.** `internal/store/gh/testdata/task_items.json` runs
  in `task_items_test.go` and `lib/taskItems.test.tsx`.
- **Text is the source line.** `taskText` slices it after finding the box with `indexOf("[")`
  from the list item's start. The paragraph's position is no use: `mdast-util-gfm-task-list-item`
  moves it past the box only sometimes (`- [ ] *a*` keeps it at the box, `1. [ ] \nfoo` lands one
  past where you would expect).
- **Optimistic state lives in `taskChecks`,** keyed by pull request and index, and shows until the
  detail has been read again (`settled`, as `changePullRequest` does), so the box never flips back
  on the way. A failure clears it at once and `runCommandForResult` toasts the daemon's message.
  Success is quiet: the box is the answer.
- A second click on a saving box sends nothing; other boxes go straight away. The daemon runs them
  in turn, and their indexes do not move because a flip changes no structure.
- A click is not a fold toggle: the box has no parent click handler to reach, and the test keeps it
  so.

## Gotchas

- The shadcn box is 16px against the native one's 13px, and it has a 3px hover ring: the 1.4em
  gutter let the ring run into the text, so a list item with a tickable box takes 1.75em
  (`.cf-markdown li.task-list-item:has(...)` in `index.css`).
- `vite.config.ts` needed `internal/store/gh/testdata` in `server.fs.allow`, as a directory: Vite
  checks `file.json?raw` against the list, and only a parent directory matches.
- A refusal's toast starts "failed precondition:", like every other pull request refusal: the
  daemon sends the kind and only the CLI strips it.
- `mock/taskBody.ts` flips plain task lines by regex, which is all the fixtures hold; it is not the
  daemon's rule. The mock refuses the next tick with `POST /__mock/gh/pr-fail?command=pr.checkbox`.
