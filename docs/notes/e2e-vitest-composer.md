# e2e → vitest: composer

The composer area of the e2e → vitest series (docs/notes/e2e-unit-duplicates.md): the
new-thread and thread composers, their pickers, attachments, the prompt history picker,
dictation in the composer, and the palette's ranking. 48 audited e2e tests (about 160 s on
the dev build): 27 removed, 21 shortened to their browser part, none kept unchanged.

## What moved

New test files:

* `components/compose/ComposerSend.test.tsx`: a project's composer from the selection (as
  App.tsx's Content keys it): the default pills (Sonnet 5, Medium, Auto, Fresh copy, From
  default) and their accessible names, the placeholder, thread.new's exact args, the cleared
  draft, Creating worktree…; a failed start (the refusal, the draft kept and editable, Work
  in's options and heading, Project folder dropping the base, an edit clearing the error, the
  send in the folder replacing the composer with the thread); the current checkout's branch
  (role note, not a stop, following the project store to another branch and a detached head),
  an existing branch, the base slot coming back; Work in by default; a local-only project's
  Branch from (rows, heading, the rule's footer, the base sent); the polish (semibold name, the
  Claude mark's colour, the neutral disabled send); a thread tag's projection on send.
* `components/compose/ComposerSets.test.tsx`: a picked workspace's set (a project out or in
  leaves it, the empty state with nothing sent, a project picked again sent alone, cmd+N on an
  empty or typed draft); a set without a git project (one Work in option, the note, the args,
  a workspace without projects); New thread on this branch (the headings, the read-only
  pill's role class and mono branch, Workspace folder as the primary, thread.new-like's args,
  a removed thread's draft and its toast); collisions (2 of 3 projects, one banner, the pill's
  and a chip's tooltips, a new branch clearing them; the banner's hints not toasted again, the
  chip's name alone and no tooltip); the heading's switcher (trigger, rows without hints,
  the checked row, a project row as the whole set with the draft and model kept, No project
  moving the draft and back); taking a project out (the confirm's title and message, Cancel,
  Confirm dropping its tags only, no confirm without references).
* `components/compose/ComposerAttachments.test.tsx`: picked and rejected files (the notice),
  × without a confirm, staging order and the attachments arg; the preview (name, size, image,
  Esc and × closing it with focus back on the thumbnail, × on the tile opening none); PDFs (the
  attach button's label and accept list, the tile's kind, pages and label, the preview's size
  line, staged page counts, the `[PDF: …]` prompt, over 20 MB, over 10 pages).
* `components/compose/PromptHistory.test.tsx`: the thread composer's picker (Up opens it in
  This thread, newest first, times, heading, hints, placeholder, arrows wrapping, Escape;
  not over a draft; the filter, its hits, No matches, Escape keeping the text; cmd+S through
  Project and All with thread names and ages, the toggle, filtering in Project; cmd+Enter
  showing the prompt in its thread), the new-thread composer's (Project, This thread
  disabled, cmd+S skipping it, Enter putting the tagged prompt back), and composer.history's
  palette page (scope, cycling, filter, Enter into the thread's draft).
* `components/compose/useRefSources.test.tsx`: "@"'s source over the mock's threads (the
  Threads group above Files, the row's project and status, the card's name, archived and
  snoozed left out with the empty text, at most three, a thread's composer leaving itself out).
* `components/palette/CommandPalette.test.tsx`: the ranking cases rendered (first and
  highlighted, one Results group, groups for an empty query), Enter on help opening help and
  not relaunching, New Thread showing the project picker with No project highlighted and
  Backspace going back, New thread on this branch and Run in only where they apply.
* `components/thread/ThreadComposerSend.test.tsx`: the failed-prompt notice (did not start,
  a turn error, an API error: the line, the icon, the buttons, Send again's thread.send args,
  any send clearing it, the draft untouched) and thread.send's projection of a thread tag.

Extended: `Composer.test.tsx` (the welcome prompt sent with Enter as a No project thread),
`ProjectPicker.test.tsx` (the mock's projects: initials, sources, numbering, hints, the
foundry query), `hostFiles.test.tsx` (a PDF in a native drop, the send reusing the staged
paths in the draft's order), `ThreadMenuItems.test.tsx` (Save as workspace in a workspace's
folder; New thread on this branch and Run in per thread shape), `SidebarRow.test.tsx` (a
workspace-folder thread's row names the workspace), `ThreadComposerDictation.test.tsx` (the
idle and busy placeholders; no mic while off or without a model, the mic before attach, an
auto-stop, turning dictation off, the unmount stop and another composer's own start),
`UserBubble.test.tsx` (a thread tag's current name, id and tooltip), `rows.test.tsx` (the
API-error row's red border).

Shared fakes, all additive:

* `src/test/composerFakes.ts`: ListRefs (the mock's branches: code-foundry's worktrees plus
  origin's release/v0.3, sketches local only), ListSkills, SearchFiles, StageAttachment
  (recorded), ListPrompts (the mock's fixtures, scoped and filtered like the daemon). No store
  imports, so vi.mock factories may import it.
* `src/test/composerWorld.ts`: `seedComposer` (projectsWorld plus the mock's settings and
  model registry, fakes reset, layout stubs), picker helpers (`openPicker`, `optionTexts`,
  `pickOption`), `send`, `settle`. `src/test/SelectedComposer.tsx`: App.tsx's Content for
  the selection (a file of its own: oxlint's only-export-components).
* `src/test/tooltip.ts`: `hoverTooltipText` for a Tip on an element that takes no focus.

Product code: unchanged.

## e2e removed (27)

compose.spec.ts: a failed start; the existing worktree's branch; Work in by default; a
native drop; a local-only repository; PDFs over 20 MB / 10 pages. composer-fixes.spec.ts:
1, 1b, 2-7-8-14-15, 2, 3, 4, 5, 9, 10, 11-13 (12 and 16 are not this area's). composer-polish:
both composer tests. composer-failed-notice: the turn error and the API error.
composer-switch: No project moves the draft. composer-threads: archived and snoozed.
composer-files: the arrows and the cached query. welcome-composer: zero projects and Enter.
prompt-history-picker: cmd+Enter. composer-collision.spec.ts and palette-rank.spec.ts went
(one test each). Measured on the dev build before #467: 84 s.

## e2e shortened (21) and what they keep

* compose: cmd+N (the global chord, real typing with Shift+Enter, the flow from thread.new over
  the streams: focus intent, naming, first message, row, idle section); attachments (a real
  paste into an empty prompt); the draft across a route change and Esc to the Projects page;
  the preview's centring and backdrop press; PDFs (pdf.js tiles, chips and canvases, backing
  size, fitting the window, paste, pdf.js's page counts staged).
* composer-switch: the switcher's place under the name, the dotted underline, focus back in the
  prompt; the skill tags typed with "/" and removed from the real editor.
* composer-threads: "@res" typed, Enter inserting the tag, its tooltip; the thread composer's
  tag typed, sent and drawn in the bubble.
* composer-files and composer-skills: the typed tags, grouping from the real trigger,
  tooltips; the file tag removed from the editor on the confirm (the skills test no longer
  repeats it: composer-switch and composer-files keep that).
* composer-failed-notice: the notice one line high and its Tab order in WebKit.
* welcome-composer: focus and the caret after the prefilled prompt.
* prompt-history-picker: Up in the real editor with the card above the composer; Up over a
  draft moving the caret; cmd+S from the focused editor and a toggle click keeping focus; a
  tagged prompt back as a chip; the palette page into the thread's editor.
* dictation: Escape in the editor; leaving the composer for cmd+N's composer stopping it.

The 21 took 75 s before; their new durations were not measured one by one.

## Gotchas

* Keys reach the real editor's keydown handler in jsdom: `fireEvent.keyDown` on
  `composer-input` runs PromptEditor's handleKeyDown, so Enter (send), Escape, and the
  prompt picker's Up, arrows, cmd+S and cmd+Enter are unit-tested on the real composer.
  Typing is not: tests set the draft text (the composer's text is the picker's filter), or
  drive tiptap through the editor its DOM node carries (`el.editor.commands.setContent`) when
  the editor's own onChange matters (an edit clearing the error).
* Radix popovers open on click in jsdom but render a tick later: `openPicker` waits with
  `findByTestId`. A cmdk item picks on click.
* Overlapping `act` scopes (a `void`ed helper that awaits inside act) left the next test
  rendering an empty container. Fire the click directly and `waitFor` instead.
* stores/failedNotice keeps a send's hold per thread for the module's life: each notice test
  uses its own thread id.
* usePromptList asks on a 0 ms timer for a new scope and after 150 ms for a new filter: the
  tests wait real time for those (microtasks are not enough).
* Turning dictation off in a unit test needs the daemon's side too: the session ends
  ("disabled") and a snapshot with `enabled: false` arrives before the setting flips;
  otherwise the last snapshot keeps the mic.
* `toast.dismiss()` in afterEach with a mounted Toaster (as in the surfaces note).
