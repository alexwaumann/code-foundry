# Code block header, and Run into the quick terminal (2026-11-18)

Follows `code-block-actions.md`. A user reported that the code blocks' Copy and Run buttons
cover the code (they sat absolutely over the block's top right), and that in the app window
at 90% zoom, hovering in and out of a block made its content seem to jump slightly. The
buttons faded in and out on hover (opacity 0 to 1 with a transition); the jump is believed to
be WebKit repainting the block as they did. It did not reproduce in headless WebKit (no layout
or pixel change), so the fix removes the cause rather than measuring it.

## What changed

1. **A header row on every fenced block** (`components/thread/CodeActions.tsx` `CodeHeader`,
   `codeActions.css`). The `.cf-code` wrapper is now the frame (border, 6px radius, code
   background) holding a 28px header row over the `pre`, with a hairline between them. Left:
   the fence's language in mono (`text-caption-sm`, muted). Right: **Run** (only where it was
   offered before: a runnable shell block in Claude's reply, finished, `terminal.new`
   available) and **Copy**, as quiet ghost buttons with an icon and a word. Always shown: no
   hover reveal, no opacity, no transition (`transition-none` on the buttons, which the shadcn
   Button otherwise animates).
   * A block with no language shows nothing at the left; the header is there for Copy.
   * A streaming block has its header from the first line; Run stays hidden until the block is
     finished (`isStreamingBlock`), as before. The streaming caret rules still hang off
     `.cf-code:last-child > pre > code`, which the header does not change.
   * Copied: the icon becomes the success check and the word "Copied". Both words sit in one
     grid cell with the idle one `invisible`, so the button is always as wide as "Copied": the
     row's height and the label's and Run's positions do not change (e2e measures it).
   * No tooltips on the header: each button shows its word. Their accessible names stay
     "Copy code" / "Copied" / "Run in terminal".
   * The header is `user-select: none` and carries `data-find-skip` and `data-cite-skip`, so
     find, citations and a drag across blocks see only the code.
   * The same blocks render wherever thread markdown does: a reply, a summary, a subagent
     report, a plugin's markdown node (`.cf-plugin-md`), the search preview and the Markdown
     file preview (both `.cf-thread`).
2. **The other users of these buttons**
   * A Bash row's command line (`ToolDetail.tsx` `BashDetail`) is one line, not a fenced block:
     no header. Its Copy is now the app's shared icon-only `components/copy/CopyButton` (named
     "Copy command" in its tooltip, since it is icon-only; a check for a moment after), always
     shown, in the 40px the line keeps free at its right, so it covers no text. It was the
     thread's own hover-revealed `CopyButton`, which is gone.
   * `ToolDiffView.tsx` already used the shared always-visible `CopyButton` in the diff's
     header: unchanged.
   * `rows.tsx`: the answer copy button (`CopyAnswer`, `.copy-answer`) is out of scope and
     untouched; `TextRow` still provides `CodeRunContext`.
3. **Run types into the thread's quick terminal** (`shell/terminalActions.ts`
   `runInQuickTerminal`, replacing `runInLinkedTerminal`). It runs `terminal.new --quick --run
   <cmd>` in the thread's context; the daemon starts the quick terminal when the thread has
   none. When the result is the quick terminal (labels `slot=quick`), the window opens it with
   `terminal.quick --id <thread> --open --focus` (cmd+j's path) and the keyboard goes in.
   Otherwise the daemon ran it in a new linked terminal tab (below) and the keyboard goes there,
   as Run did before.

## The busy rule lives in the daemon

`terminal.new --quick --run` types into a running quick terminal only when its shell is at its
prompt. Otherwise it starts an ordinary shell of the thread (a tab placed by the rules, the
same path as `terminal.new --run`) and returns that one, with "thread X's quick terminal T is
busy; " in front of the message. `--quick` without `--run` still returns the busy terminal.
The CLI verb gets the same rule: typing into a running program is never what a caller wants.

* Why the daemon: the frontend's `Foreground` is the sampled fact (`facts.go`), published
  `FactsDelay` after output and rechecked on a schedule, so a command typed a moment ago may
  not show yet. The daemon reads the PTY's foreground group when asked
  (`terminal.Store.AtPrompt`, an ioctl on the terminal's actor), under the mutex that already
  serializes finding and starting a thread's quick terminal, so two Runs cannot both see it
  idle once the first command has started.
* `AtPrompt` is true only when the foreground group is the terminal's own process (the
  shell). A foreground group that cannot be read (`fgKnown` false in the facts' terms: the
  ioctl failed) or an exited process is **not** at its prompt, and a failed `AtPrompt` call
  counts the same: the safe side is a new terminal, never typing into something unknown.
* `TerminalDeps.AtPrompt` nil (tests that do not wire it) skips the check and types, as before.
* A gap left: a second Run within the few milliseconds between the first command's Return and
  the shell forking its job sees the shell still in the foreground and types after it; the
  shell then reads that line when the first command ends. Not reachable by clicking (each Run
  is two round trips); not worth a "typed at" timer.
* Order on a first Run: `terminal.new --quick --run` creates the shell and waits for its
  prompt (up to `DefaultRunWait`, `promptSettle` 150ms of quiet) before the window opens the
  quick terminal, so it appears after the shell's startup rather than at once. Opening it
  first (`terminal.quick --open`) would race: the busy check could run during the shell's
  startup files, whose subprocesses own the foreground, and send the first Run to a tab.

## Tests

* Go: `TestAtPrompt` (real zsh: at the prompt, while `sleep` runs, after ^C, exited);
  `TestTerminalNewQuick` gains idle, busy, unreadable, first-run and no-`--run` cases.
* vitest: `CodeActions.test.tsx` (header contents per block kind, header before the code and
  skipped by find/cite, streaming, copied state keeping both words, the Bash row's icon-only
  Copy, Run calls `runInQuickTerminal`); `terminalActions.test.ts` (the quick result opens and
  focuses the quick terminal; the busy result's tab takes the keyboard; a refusal opens
  nothing).
* e2e `code-block-actions.spec.ts` (browser only): computed opacity and transition with no
  pointer, header box above the code box, the quick terminal opening live with the keyboard,
  the busy fallback tab, copied state geometry.
* The mock's `terminal.new` takes `--quick` with the same busy rule (its `foreground` fact,
  set with `/__mock/terminal/facts`).

## Gotchas

* The `.cf-code` class used to be on the Bash row's command line too (for the button's
  positioning). It is `.cf-cmd` now; `.cf-code` means a fenced block's frame.
* `index.css` frames `.cf-markdown pre` (border, radius, background) for every markdown
  surface; inside `.cf-code` the pre drops them and the wrapper draws the frame.
* `e2e/live-codeblock.spec.ts` (opt-in, real daemon) only lost its hover/opacity lines; it
  still expects the old bottom panel and was already stale before this change.
