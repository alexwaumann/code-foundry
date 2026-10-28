# Prompt history 2: the Previous prompts picker (2026-10-28)

PR D of the prompt-recall series. A user asked for the Claude Code CLI's up-arrow recall.
Cycling prompts into the draft on each Up replaces what the user typed, which is the bug
the CLI is reported for, so the app does it differently: Up in an empty composer opens a
"Previous prompts" card above the composer, and the same list is a command palette page.
It builds on PR A's `ThreadService.ListPrompts` (docs/notes/prompt-history-1-daemon.md).
GUI plus one registry command, `composer.history`. The daemon only gains that command, so
it needs a restart for the palette and CLI entry; the Up key works without one.

## The card (both composers)

- Trigger: a plain Up while the prompt is empty (no text, attachments or tags), no `/` `@`
  `#` card is open, nothing is docked (permission or question) and no send is in flight.
  IME composition never reaches it (PromptEditor drops composing keys first). The thread
  composer opens in This thread; the new-thread composer opens in Project, its Work in set
  (`projectIds`; a like draft uses its thread's set; No project passes neither, which the
  RPC reads as the threads without a project), with This thread disabled.
- Where: `components/compose/PromptHistoryCard.tsx`, in the completion card's container
  (overlaid, `bottom-full`, rounded-lg, border, raised surface), above the composer in both
  composers. It is opaque: the completion card's 85% surface let transcript text show
  through behind the header. Its height uses the completion card's fit
  (`useFitBelow`, moved to its own file so both cards share it).
- Header: the overline "Previous prompts", then " · N matches" while filtering, and
  " · latest 50" when there are more. The brief asked for " · N of M", but ListPrompts
  returns no total and its scan stops once the list is full, so the picker asks for 51
  and says only that more exist. A daemon count would mean scanning every prompt.
- The scope toggle is the shared shadcn Tabs list (the app's segmented control), small.
  A mousedown on the card or the toggle keeps the keyboard in the prompt.
- Rows: the prompt on one line (whitespace collapsed, truncated, filter hits in a
  `mark`), then the sent time in This thread (`lib/format sentTime`), or the thread name
  (max 160px, a button that shows the prompt in its thread) and a relative age in
  Project and All. The selected row has the control-hover background and a ⏎.
- Footer: ↵ Use, ⌘↵ Show in thread, ⌘C Copy, ⌘S Scope, esc Close (Kbd sm chips; hidden
  when the card is very short, like the completion card's hints).
- Placeholder while open: "Type to filter previous prompts".

## Keys and filtering (lib/promptHistory.ts, table-tested)

- `pickerAction`: Up/Down move (wrapping), Enter uses, cmd+Enter shows, cmd+S cycles the
  scope (skipping This thread when it is disabled), Escape closes. cmd+C copies only when
  nothing is selected in the prompt, so copying a selection still works. Anything else
  goes to the editor, so typing edits the filter.
- PromptEditor gained `onKeyDown(e, selectionEmpty)`, called before the completion card
  and the editor's own keys. The picker uses it for Up and then for its own keys, so
  Enter does not send and Escape does not leave the new-thread composer while it is open.
- The filter is the draft's text (`proseOf`, trimmed). `/`, `@` and `#` completion is off
  while the card is open (the editor gets no triggers). ListPrompts gets the filter as
  `query` after 150ms. A new scope or a new opening asks at once and shows "Loading
  previous prompts…"; a new filter keeps the last answer until the next one lands, and
  answers to older requests are dropped. The card opens on the keypress, before the RPC
  answers.
- Escape closes the card and leaves the typed filter as the draft. Focus leaving the
  composer closes it too, unless the whole window lost focus. A send, docked prompts or a
  change of thread also close it.

## Actions (stores/promptHistory.ts)

- Use: `insertPrompt` replaces the draft's text with the composer text when there is one,
  so tags come back as chips, else the text. It goes through `lib/failedPrompt
  draftOfSent` like the failed-prompt notice's Edit, so citations get new draft ids. The
  caret goes to the end a frame later. Nothing is sent.
- Show in thread: `revealPrompt` selects the prompt's thread if it is not already on
  screen, then retries for up to 180 frames until `getTimeline(thread).showRow(itemId,
  "start")` succeeds. That is the rail's jump: `showRow` gained an `align`, and "start"
  unpins and scrolls the row to just under the top. A prompt the timeline does not have
  leaves the thread selected. The mock's fixture prompts are such prompts: their item ids
  are not in any log.
- Copy: `lib/clipboard copyText`, then a "Prompt copied" toast. The card stays open.

## composer.history and the palette page

- `internal/command/commands_view_composer.go`: `composer.history`, title "Previous
  Prompts" (title case like the rest of the registry), View category, no default chord,
  listed in the palette. Its Run emits ShowView "composer.history", so the CLI verb
  reaches every window. In the GUI it has a presenter (keys/bindings.ts) and a views.ts
  case that both call `presentPromptHistory`: if the composer that holds the keyboard is
  registered (each composer registers while mounted), its picker opens; otherwise the
  palette opens on its `prompts` page, deferred because a palette pick closes the palette
  after the presenter runs. The registry and the presenter are in
  `stores/historyComposers.ts`, which imports only the UI store: putting them in
  stores/promptHistory.ts pulled the compose store into views.ts's imports, and broke
  unit tests that mock `@/api/threads`. It is left out of the agents' guide (`guide.leftOut`, beside
  thread.prompts): it is the user's window action, and its topic line put the guide 8
  bytes over its cap.
- `components/palette/PromptsPicker.tsx`: cmdk with its own ranking off, input "Search
  previous prompts…", the scope toggle in the input row, and rows using the card's row
  body (`PromptRowBody`; the ⏎ shows on cmdk's selected row through a group variant).
  Footer: ↵ Insert into composer, ⌘↵ Show in thread, ⌘C Copy (⌘S also cycles). cmdk does
  not report automatic highlights, so cmd+Enter and cmd+C read the selected row from the
  DOM, as the command list does.
- The starting scope: This thread when a thread is on screen. Project with the new-thread
  composer (its set) or an active project. All when there is neither: Project with no
  source would mean "the threads without a project", which is not what the user is
  looking at.
- Enter puts the prompt in the thread's composer, else in the new-thread composer's
  draft. With neither on screen it opens the new-thread composer where the prompt's
  thread worked (its workspace, else its project, else No project) with the prompt as
  the draft.

## Mock and tests

- mock/world.ts lists `composer.history`; the prompts themselves come from PR A's
  mock/prompts.ts.
- `src/lib/promptHistory.test.ts`: relative age (minutes, hours within a day even across
  midnight, yesterday, days, dates), the key table, the open rule, wrapping, the scope
  cycle, the header and the hit ranges.
- `e2e/prompt-history-picker.spec.ts`: Up opens the card in This thread with the scripted
  thread's two prompts, above the composer, with focus kept; Up over a draft does nothing;
  filtering with highlighted hits, "No matches", and Escape keeping the typed draft; Enter
  and a click inserting; cmd+S cycling scopes with thread names, and a click on the
  toggle keeping focus; cmd+Enter in Project selecting the prompt's thread; the new-thread
  composer opening in Project with This thread disabled and a thread tag coming back as a
  chip; the palette page through the command (scope, filter, cmd+S, Enter into the
  thread's composer). With SHOTS=<dir> it writes the PR's dark and light screenshots.
- Go: commands_test's full list and commands_view_test's ShowView table include the
  command.

## Gotchas

- In WebKit, Up in a one-line prompt moves the caret to the start of the line, so a test
  that types, presses Up and then Backspace deletes nothing.
- The palette resets to the command page as it closes and keeps that page rendered while
  it fades out. A test that presses another chord right after Escape has to wait for it to
  go.
- "flushSync was called from inside a lifecycle method" shows in the console whenever a
  draft with tag chips is rebuilt from outside (here, and in the failed-notice spec on
  main). It comes from TipTap's node views and is harmless.
