# Regenerate a thread's name

A thread's name comes from its first prompt (provisional, then the naming model's title).
Regenerate name asks the naming model again. Since 2026-11-17 the name says the thread's
**overall task** and stays the same unless the topic really changed (see "The rule
changed" below); the first version named "what the thread is doing now".

## The rule changed (2026-11-17)

A user found Regenerate name naming a thread after its last small follow-up. The cause:
the context was the last 3 user messages plus assistant text, capped at 4000 bytes keeping
the newest text, so one long final reply filled the cap and the model saw only the tail
of the last exchange; the prompt ("judged by its most recent turns") pushed the same way.
Reproduced on a scratch daemon with Sonnet 5.5: a thread asked to make `slugify` robust,
then "thanks, also fix the typo…", then a 5.3 KB explanation of NFKD; the old context and
prompt gave "Explain Unicode NFKD accent stripping".

The user's decision: the name says the thread's overall task, stable unless the topic
really changed. This replaces the 2026-10-31 rule "what the thread is doing now".

- **Context** (`threadNamingContext`, `internal/store/thread/regenerate.go`):
  `Current name: <name>` when the thread has one that is not provisional (a provisional
  name is the first message again); the first user message (the original task); a
  `(<n> user messages left out)` line when the recent turns do not reach it; then the last
  6 user messages and the assistant text after each. The first message appears once when
  it is one of the 6.
- **Each block is capped on its own**, so no single long reply can crowd out the rest:
  the first message 1200 bytes, a later user message 600, an assistant block (its text
  blocks in a row, joined) 300. A long block keeps its **head and its end** around `…`
  (two thirds head, cut at rune boundaries, spaces at the cut trimmed): the head holds the
  ask or the plan, the end holds a question typed after pasted logs, or a reply's
  conclusion. Head only would lose "…here is the log. Why does this fail?"; tail only
  (the old rule) loses the ask.
- **Overall bound** `maxNamingContext` (8000 bytes). The per-block caps keep every
  context under it by construction (worst case about 7000 bytes: a 200-byte name, the
  first message, the gap line, 6 user and 6 assistant blocks at their caps, labels and
  separators), and `TestThreadNamingContextBound` checks that worst case, so there is no
  drop-the-oldest pass.
- **Prompt** (`threadGuide` in `naming.go`, in both the title-only and the title+branch
  prompts): name the overall task; the latest messages may be small follow-ups and must
  not decide the name on their own; keep the current name's subject unless the work
  clearly moved on. The conversation goes under `Thread:` (was `Recent conversation:`).
  Title format rules unchanged.
- **Move** uses the same context and wording (it named a moved thread from
  `recentTurnsContext` too), so the two stay one rule.
- Verified end to end on a scratch dev daemon (`models.utility` = Sonnet 5.5, thread on
  Sonnet 5.5 medium): after the task, "thanks, also fix the typo in the summarise
  docstring" and the long NFKD reply, five regenerates all gave "Make slugify robust with
  tests" (the first-prompt name). Two turns on an unrelated new task (`word_count`,
  `reading_time`) then gave "Add word_count and reading_time helpers" twice: a real topic
  change still renames.

## Decisions (2026-10-31; the context and prompt are superseded above)

- **Context is the last few turns, not the whole thread.** `recentTurnsContext`
  (`internal/store/thread/regenerate.go`) takes the thread's last 3 user messages and the
  assistant text after each, oldest first, as `User: …` / `Assistant: …` blocks (an
  assistant's text blocks in a row join into one block). Left out: wakes (a user message
  with a `WakeTitle`), subagents' items (`ParentToolUseID`), API error messages
  (`APIError`), and every other kind (tool calls, thinking, notes, command output,
  compaction). Capped at 4000 bytes keeping the newest: whole oldest blocks go, and the
  oldest block kept loses its start (`User: …<tail>`), cut at a rune boundary. The items
  come from `Manager.Items`, which loads the log from `thread_items` when it is not in
  memory, so a stopped thread works too.
- **Prompt variant.** `NamingRequest.Conversation`; when set, `buildNamingPrompt` writes
  `regenerateNamingPrompt` ("names what the coding thread below is currently working on,
  judged by its most recent turns", same style rules) then `Recent conversation:\n…`.
  `Message` and `Branch` are ignored for it; `parseNaming`/`cleanTitle` read the reply as
  any title-only call's.
- **Replaces any name, no confirmation.** A hand-typed name too: it is an explicit user
  action. The result is `Name = title`, `AutoNamed = true`, `NameProvisional = false`, and
  the record's `namingTried = true` so a first-prompt naming call that has not started
  never will. It sets the fields directly: `applyNamerTitle` refuses a name that is
  `namedForGood`, which every hand-typed name is.
- **Ignores `threads.auto_name`.** `thread.WithExplicitNaming(ctx)` marks the call;
  the daemon's `settingsNamer` (`internal/daemon/settings.go`) skips its AutoName gate
  for it. `threads.naming_model` still applies (and the effort is always low).
- **Refusals** (`ErrFailedPrecondition`): a resident thread (`refuseResident`, the
  same wording archive/snooze/fork use), a thread with no user message ("nothing to name
  yet"), and a second call while one runs.
- **One call per thread: the second is refused, not joined.** The simpler of the two
  options. The in-flight guard is the snapshot flag itself, checked and set under
  `m.mu`, so there is no extra state to clean up. The GUI disables the menu item while
  the flag is set, so only the CLI or an agent can hit the refusal.
- **Synchronous RPC.** `ThreadService.RegenerateName` returns the renamed thread once the
  model answered, bounded by `NamingTimeout` (20s), the caller's ctx and the store's (a
  shutdown cancels it). A rate-limited answer is retried once after `NamingRetryDelay`,
  as `startSlug` does. The CLI prints `renamed thread <name> (<id>)`.
- **`Thread.Naming` is transient.** Set (published, not persisted) before the model call,
  cleared after, success or failure; `codefoundry.v1.Thread.naming` (73) and
  `ThreadView.naming`. Only Regenerate name sets it: the first-prompt namer shows a
  provisional name instead. Not in `saveThread`, so a daemon that dies mid-call comes back
  with it off.
- **Failure keeps the name**; the command returns the error and the GUI's `runCommand`
  toasts it.
- **GUI.** "Regenerate name" (lucide `Sparkles`) right under Rename in `ThreadMenuItems`
  (sidebar row context menu and the header's title menu), `data-testid
  menu-regenerate-name`, calling `regenerateThreadName(id)` (`stores/threadActions.ts`,
  `THREAD_COMMANDS.regenerateName`). Hidden for resident threads (`ThreadView.resident`),
  disabled while `naming`. It is an in-place item (`markInPlace`): the title menu hands
  the keyboard back to the prompt. While `naming` is set the sidebar row name (both row
  layouts) and the header title render exactly like a provisional name (muted, italic,
  `data-provisional` on the row's name). Not disabled for a thread without a user
  message: the view model does not know that cheaply, so the daemon's "nothing to name
  yet" toasts instead.
- **Command.** `thread.regenerate-name` ("Regenerate Thread Name", category Thread, args
  `id`, `When: hasThread`), in `commands_thread_lifecycle.go` beside `thread.rename`;
  listed in the palette, no keybinding. `ThreadBackend` gained `RegenerateName`.

## Gotchas

- The agent guide (`internal/guide`) has a soft size cap (`TestWriteTopic`, 25,600 bytes)
  and the new verb pushed it to 25,680. It is a user's menu action (agents name a thread
  with `thread rename`), so it joins `leftOut` with `thread.restart` and
  `thread.new-like` rather than raising the cap; `code-foundry commands` and `help` still
  show it.

- The env namer in the store tests answers `strings.Fields(req.Message)[0]`, which
  panics on an empty message: a regenerate test must set `e.namer` before the call
  (its request has only `Conversation`).
- The mock daemon's async command runners must return an `InvokeOut`, not a string (the
  sync ones may return a string).
- `e2e/snooze.spec.ts` "Pick a date and time…" fails on the 31st of a month: the snooze
  dialog's next month from Oct 31 is December, so `data-day="…-11-10"` is not there.
  Pre-existing and unrelated; it passes on other days.

## Verified

- Store: `TestRecentTurnsContext` (table), `TestBuildNamingPromptConversation`,
  `TestRegenerateName` (replaces a hand-typed name, persisted, explicit ctx, naming flag
  while in flight, second call refused, failure keeps the name), `TestRegenerateNameRefusals`.
  Daemon: `TestSettingsNamer` covers explicit naming with auto-naming off. Command table
  cases in `commands_thread_lifecycle_test.go`.
- GUI: ThreadMenuItems order/resident/disabled cases, SidebarRow and ThreadParts naming
  styling, e2e "Regenerate name in the row menu…" in `e2e/threads.spec.ts`.
- End to end, daemon + CLI on a scratch `CODE_FOUNDRY_HOME`: with the real `claude` the
  naming call failed (the account could not use the pinned 1M models): the CLI printed the
  error, the name stayed, `naming` was off. With `advanced.claude_path` pointed at a stub
  that logs its prompt and `threads.auto_name = false`: `thread regenerate-name` printed
  `renamed thread Go context and cancellation (<id>)`, `thread get --json` showed
  `autoNamed: true` and no provisional or naming flag, the stub got the
  `Recent conversation:\nUser: …` prompt, a hand-typed rename was replaced by the next
  regenerate, and a thread with no message got "nothing to name yet".
