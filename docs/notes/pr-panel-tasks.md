# PR panel redesign, PR D2: the readiness rows hand their issue to a thread

The readiness box's issue rows (D1, `pr-panel-readiness.md`) now carry their thread task:
"Fix in this thread", "Address in new thread", "Resolve in <thread>", "Update in …",
"Review in new thread". They run `pr.task` (#497, `pr-tasks.md`) through the command
registry.

## What shipped

- `components/pr/taskRouting.ts` (pure, `taskRouting.test.ts`):
  - `taskVerb(task, detail, viewer)`: checks → Fix, review → Address, conversations →
    Address, conflicts → Resolve, behind → Update, review-request → Review. Null (no
    button) for a pull request that is not open, and for a push kind (every kind but
    review-request) when the viewer has neither write access (`viewerCanUpdate`) nor
    authorship. A fork the viewer cannot push to is not predicted: the daemon refuses and
    its error toasts.
  - `taskRouting({selection, ref, threads, isProject})`: the default target and the ▾
    menu. Rule 1: the selected thread's linked pull requests include this one (slug ignoring
    case + number) → "this thread" (`--thread <id>`). Otherwise → new thread (no
    `--thread`; the daemon reuses or creates the head branch's worktree, or clones). The
    menu lists the default first (with a check), then "In a new thread" or "In this thread"
    (any selected thread the store knows, linked or not), then up to 3 other non-archived
    threads that link the pull request, most recently active first (created time when
    never active), as "In <current name>" (the id when unnamed). Not a project → the new
    thread item's hint "Clones <owner/repo> first".
  - `isProjectRepo`: a project's GitHub slug matches the ref's slug or the detail's
    `repoSlug` (GitHub's current name), ignoring case, as the daemon looks for a clone.
- `stores/prTasks.ts`: `runPrTask(ref, kind, target)`; one run per pull request + kind
  (`running`), a second press sends nothing. Success toasts the daemon's message with
  **Open** unless the thread is already selected at that moment (a send into this thread;
  a new thread the daemon's FocusThread selected first). Failures go through
  `runCommandForResult`'s toast ("Hand Pull Request Task to Thread failed" + the daemon's
  error).
- `components/pr/TaskButton.tsx`: the split button in the row's action slot (under the
  row's text, beside Ready for review / Approve on GitHub when a row has both). No icon.
  `SplitButton` gained `size="xs"` (24px, the row buttons' height), an optional icon (the
  spinner leads only while busy), a `tip` shown when the label is cut short, and the
  menu's width.

## Decisions

- The default target is never another thread (rule 2 defaults to a new thread), so the
  main button reads "… in this thread" or "… in new thread"; other threads' names only
  appear in the menu, truncated with a whenTruncated tooltip.
- An archived selected thread that links the pull request is still "this thread" (sending
  unarchives it, as any send does); archived threads are only left out of the others.
- A new thread keeps pr.task's default `--focus` (true), like Explain / Fix findings: the
  window moves to it. The Open action covers a stream that missed the FocusThread.
- A send's toast drops the daemon's "; <next>" (`taskToast`): that part is thread.send's
  `thread wait <id> --after N` line or the subscription note, written for an agent on the
  CLI. Cut after the "(#N)" ordinal, since a thread name may hold "; ".
- Until the projects store has loaded, the repository counts as a project (no clone hint
  on a guess).
- The ⋯ menu's "Fix findings in a thread" (`pr.fix.findings`) stays. It is the all-in-one:
  one new thread for every finding (failing checks, requested changes, unresolved
  conversations) with fix.findings' prompt, while each row hands over one issue and can
  target an existing thread. Removing it would make "fix everything" five presses into
  possibly five threads.
- The threads the button reads are selected as the store's own objects (`useShallow` over
  the selected thread and the ones linking the pull request), so other threads changing
  re-render nothing.

## Gotchas

- `src/test/projectsWorld.ts`'s `thread()` had no `linkedPullRequests`; the real API always
  sets it. Added `[]` (TaskButton reads it without `?? []`).
- D1's e2e "a row's button sits under its text" only looked at `[data-slot=button]`; the
  split button's parts are plain buttons, so the check now includes `[data-testid^=pr-task-]`.

## Verification

- vitest: `taskRouting.test.ts` (every rule, case-insensitive matching, another number,
  archived excluded, the cap and order, an unknown selection, the clone hint, labels,
  args, each verb and when it hides), `stores/prTasks.test.ts` (result parsing, the
  toast cut), `PrTasks.test.tsx` (the buttons per fixture and viewer, merged/closed none,
  `pr.task` args per target, Open and selecting, busy + second press, a refusal's toast).
- e2e: `pr-panel.spec.ts` (every state at 360/420/560, buttons under their text),
  `pr-code.spec.ts`, `linkedprs.spec.ts`.
- Driven against the mock (`make drive`): from "Fix resize race" linked to #145, "Fix in
  this thread" sent the follow-up into the thread (it started working, toast without Open);
  from it on #161 (linked by "Investigate flaky e2e"), the menu's "In Investigate flaky
  e2e" sent there (toast with Open, selection kept); #139's "Review in new thread" from
  the Pull Requests page started a thread on the `jsonl` worktree and selected it.
