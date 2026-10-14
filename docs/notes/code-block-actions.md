# Code block actions: Copy and Run in terminal (2026-10-14)

Decided with Alex:

1. **Copy on every code block** in a thread's timeline (fenced blocks in any markdown the
   thread shows) and on a Bash row's command. Copies the raw code, shows a check and
   "Copied" for 1.5 s.
2. **Run in terminal on shell blocks in Claude's replies**: a new shell tab in the thread's
   bottom panel types the command and Return, stays open after it, the panel shows and
   the shell takes the keyboard. A registry command: `terminal.new --run "<cmd>"`, so the
   CLI has it too (`code-foundry terminal new --run 'make test'`); the palette's New
   Terminal does not prompt for it (optional string args are never prompted).

Status: `make check` green; e2e (both browsers) for `code-block-actions`, `thread`,
`thread-prompts`, `bottom-panel`, `terminal-routing`, `no-project`, `app`,
`thread-slash-commands`, `thread-retry`, `thread-cold-cache`: green; live run against a
real daemon (below): green.

## Pieces

| File | Change |
|---|---|
| `internal/store/terminal/await.go` | `AwaitOutput(ctx, store, id, quiet)`: attach, then wait for the first non-blank output (or a non-blank screen already), then until `quiet` passes without more output. `ErrExited` when the process ends before printing, ctx's error on timeout |
| `internal/command/commands_terminal.go` | `--run` on `terminal.new`; `TerminalBackend` gains `Write`; `TerminalDeps.AwaitOutput` and `RunWait` (default `DefaultRunWait`, 5 s); `runInput` (the keys typed), `typeRun` (wait, then Write) |
| `internal/command/commandtest` | `Terminal.Write` (+ `WriteErr`), the `Output` fake for `AwaitOutput` (nil, `Block`, `Err`, `OnAwait`) |
| `internal/command/all/all.go`, `internal/daemon/daemon.go` | `AwaitTerminalOutput` wired to `terminal.AwaitOutput` with `promptSettle` = 150 ms |
| `lib/codeActions.ts` | `runnableCommand(lang, code)`, `isStreamingBlock(text, code, streaming)` |
| `components/thread/CodeActions.tsx`, `codeActions.css`, `codeContext.ts` | `CopyButton`, the Run button, `CodeActions`; `CodeRunContext` (provided by `TextRow`) |
| `components/thread/Code.tsx` | `CodeBlock` wraps the `pre` in `.cf-code` with the actions |
| `components/thread/ToolDetail.tsx` | the Bash command line gets a Copy button |
| `components/thread/rows.tsx` | `TextRow` provides `CodeRunContext` (session, text, streaming) |
| `components/thread/Timeline.tsx` | the ResizeObserver also watches the scroll container (see Gotchas) |
| `stores/bottomActions.ts` | `openBottomShell(key, { command })` passes `run` to `terminal.new` instead of writing itself; `runInThreadTerminal(sessionId, command)` |
| `mock/world.ts` | `terminal.new` takes `run`: types it (via the mock's write) 150 ms after creating the shell |

## Decisions

* **The daemon types, not the GUI.** `terminal.new --run` creates the shell, waits for its
  first output (`AwaitOutput`), then writes the keys. Typing right after the start makes the
  PTY echo the line above the prompt and zsh echo it again after it (the gotcha in
  `bottom-panel-autoshell.md`); live, with the wait, each line shows once, after its
  prompt.
* **First output, then 150 ms of quiet.** A startup file that prints ahead of the prompt,
  or a prompt drawn in pieces, gets that long to finish. A blank screen (only newlines)
  does not count as output.
* **Timeout: type anyway.** After `RunWait` (5 s) with no output the command is typed
  anyway (logged at warn): a slow shell still runs it, only echoed twice. Any other wait
  failure (the shell exited before printing, the caller went away) fails the command with
  "created terminal X, but could not run the command"; the shell stays. A failed Write
  fails the same way.
* **What is typed** (`runInput`, `runKeys`): CRLF becomes LF, trailing newlines/spaces/tabs
  go. A blank value types nothing. Control characters other than tab and newline (ESC, ^C,
  a lone CR, DEL) are refused with InvalidArgument before the shell starts: a code block has
  none, typed into a shell they do things, and an ESC could end a bracketed paste early.
* **Pasted when the shell reads bracketed pastes** (review fix). After the wait the daemon
  asks the terminal whether mode 2004 is on (`terminal.Store.BracketedPaste`, read from the
  emulator on the actor; zsh and bash 5.1+ turn it on while their line editor reads a line).
  If so the text goes as one `ESC[200~ … ESC[201~` paste and then Return: the line editor
  inserts it as is and Return runs the whole buffer. Typed key by key instead, a tab is the
  Tab key, so zsh and bash completed on it: `printf "%s\n" a<TAB>b` ran as `printf "%s\n" ab`
  (checked in a PTY with Alex's zsh), and `cat RE<TAB>` would have run `cat README.md`.
* **Without bracketed paste (macOS /bin/bash 3.2, sh) the keys are typed**: every line end
  becomes Return (CR, what Enter sends) and one Return ends it, so each line runs in turn as
  the shell reads it. Lines after the first are typeahead while the first runs, so a slow
  first command (a build) makes the PTY echo the later lines early, like typing ahead by
  hand; they still run once. `\` continuations and heredocs work (the shell's PS2). Tabs
  stay the Tab key there.
* **Which blocks get Run** (`runnableCommand`): fence languages `bash`, `sh`, `shell`, `zsh`
  (any case) run as written; when every non-blank line starts with `$ ` (a transcript
  fenced as bash) the prompts are dropped. `console` is a transcript: only its `$ ` lines
  run, without the prompt, with their `\` continuation lines; output lines are left out. A
  console block with no `$ ` line is ambiguous and gets no Run. `#` and `%` prompts are not
  read (`#` is a comment in scripts). No language, `shellsession` and everything else: Copy
  only.
* **Only in Claude's replies.** `TextRow` (the main thread's and a subagent's text) provides
  `CodeRunContext`; compaction summaries, subagent reports, tool output and Bash rows do
  not, so their blocks only copy. A Bash row's command is copy only (no run, as decided).
* **Hidden while streaming.** A block whose reply streams and after whose code only
  whitespace or the closing fence follows is still being written: no Run. Earlier blocks of
  a streaming reply (text after them) have it. Copy is always there.
* **Only when terminal.new is available** for the context (the commands store's
  `available`, the visible thread's). Every thread has it, no-project threads included
  (the shell is owned by the thread and starts in its home; checked live with the CLI).
* **Each click is a fresh shell** (`openBottomShell(..., { fresh: true, command })`); the
  previous one stays as its own tab.
* **Focus.** With `--run`, `terminal.new` returns only after the prompt, so the shell's
  `updated` event arrives first: `openBottomShell` marks the key's pending focus
  (`markPendingFocus`, as cmd+t does) so the arriving shell takes the tab and the keyboard
  at once. When the result comes back, the shell is focused by id only if no shell claimed
  that pending focus (so a user who moved on while the daemon waited is not pulled back).
* **Look.** Small bordered icon buttons (22 px, the pane's background so they cover the code
  under them) at the block's top right: Play (Run in terminal), then Copy. Hidden until the
  block (or a Bash row) is hovered or a button has focus; a just-copied button stays shown
  until its check goes. They stay in the tab order (Option+Tab in WebKit, Tab in Chromium).
  Icon-only, so they carry `title` and `aria-label`, like the turn footer's copy button.

## Gotchas

* **The timeline did not follow the bottom panel opening.** Its ResizeObserver watched only
  the content; the panel opening shrinks the scroll container, so the pane kept its
  scrollTop and the block clicked scrolled under the composer (seen live; cmd+j had the same
  effect). The observer now also watches the scroll container, and a pinned list scrolls to
  its end. The mock e2e checks the timeline is still at the bottom with the block in view.
* **The streaming caret** (`.cf-streaming > pre:last-child > code::after` in thread.css)
  no longer matches a wrapped block; `codeActions.css` adds the rule for
  `.cf-code:last-child > pre > code` and removes the caret after the wrapper itself, so
  thread.css (which PR #90 also edits) is untouched.
* `.cf-markdown`'s first/last child margins apply to the wrapper; the inner `pre` has no
  margin of its own (`.cf-markdown :where(.cf-code)` keeps the 0.5em at the lowest
  specificity).
* WebKit does not move focus to buttons with Tab (Safari's default; the Wails window is the
  same): the keyboard e2e presses Option+Tab there.
* Playwright's clipboard read works in Chromium (with `clipboard-read`/`-write` granted);
  in WebKit the e2e checks the Copied state only.
* `playwright.live.config.ts` matches `live(-[a-z]+)?.spec.ts`, one hyphen: the live spec
  is `live-codeblock.spec.ts`.
* The go test build cache can carry another worktree's libghostty-vt path in its cgo flags:
  run `go test` with this worktree's `PKG_CONFIG_PATH` (the Makefile sets it).
* Off Bedrock, `claude-4.5-haiku[1m]` is refused ("issue with the selected model"); the
  live thread switched to `claude-haiku-5-5[1m]`.

## Tests

* Go: `internal/store/terminal/await_test.go` (output after attach, already on screen, a
  blank screen does not count, more output restarts the quiet period, no output until the
  deadline, exit before and after printing, unknown terminal);
  `internal/command/commands_terminal_run_test.go` (no or blank `--run`, one line, trailing
  newline, CRLF, multi-line, tabs, ESC / DEL / lone CR refused before Create, timeout types
  anyway, the shell exiting first, the caller going away, a failed Write, no AwaitOutput;
  the wait always comes before the Write).
* vitest: `lib/codeActions.test.ts` (language and console handling, streaming detection);
  `components/thread/CodeActions.test.tsx` (copy raw code and the Copied state, Copy outside
  replies without Run, the Bash row, Run for bash and console, none for other languages, a
  streaming block, terminal.new unavailable); `stores/bottomActions.test.ts` (`run` arg,
  focus on arrival once, focus by id when nothing arrived, `runInThreadTerminal`).
* e2e `code-block-actions.spec.ts` (both browsers): Run hidden while the bash block
  streams, shown on hover once finished, one `terminal.new` with `run` in the thread's
  context, a new live tab with the keyboard, the mock typed `cmd\r` once into that shell,
  the timeline still at its end; a second click opens a second tab. Copy: clipboard
  content (Chromium) and Copied; a Bash row's Copy command, no Run. Keyboard: focus shows
  the buttons, Enter copies.
* Live `e2e/live-codeblock.spec.ts` (below).

## Live run and screenshots

Daemon from this worktree (`CODE_FOUNDRY_HOME=/tmp/cf-cba/home bin/code-foundry daemon
--dev`), a plain-folder project `~/cf-cba-scratch`, a thread there (`session new --model
'claude-haiku-5-5[1m]' --effort medium`, see Gotchas) asked for one sentence and a bash
block with `echo run-$((6*7))` and `pwd`. Vite on 9356 pointed at the daemon; WebKit:

1. Hover: Run and Copy show on the block (`block-dark.png`, `block-light.png`).
2. Run: one new tab in the thread's panel, attached, with the keyboard; the daemon lists
   exactly that shell for the thread. The screen shows `echo run-$((6*7))` once, `run-42`,
   `pwd` once, `/Users/alex/cf-cba-scratch`, and a fresh prompt. 1.5 s later the shell is
   still running and still the tab (`ran-dark.png`, `ran-light.png`). No "typing anyway"
   warning in the daemon log.
3. CLI: `terminal new --run 'echo cli-run-$((6*7))'` in the project, and `terminal new
   --context-session <no-project thread> --run …` (shell owned by the thread, in the home
   directory): both "created terminal … and ran the command in it".

Screenshots are the browser build against the real daemon at 1200x720, 1x, not the Wails
window.

## Daemon restart

Needed: `--run` is a new `terminal.new` argument. An older daemon refuses the unknown
argument, so Run in terminal fails with a toast until the daemon restarts.
