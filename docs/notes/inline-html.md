# Inline HTML pages in the conversation (2026-10-22)

Alex picked sketch variant A (docs/sketches/model-phase1, `view=thread&variant=a`): the
model can show an HTML page inline in a thread's conversation, as a thread item. A
"Showed <file> <dir>" work-log row with a chevron, and under it a card: a strip (file
icon, `dir/` muted and the file name in mono, then open in side panel, expand, source,
save as artifact) over the File tab's sandboxed frame. Daemon, CLI, GUI, mock and skills.

## Item

- `ThreadItem.html` (`HtmlItem{path, title, base_dir}`), kind `html` in `thread_items`
  (the JSON `data` column gains `html: {path, title, base_dir}`; no migration). `path` is
  relative to the thread's cwd when inside it, else absolute; `base_dir` is that cwd when
  the item was made, so the GUI resolves the path without the thread's current placement.
  The page's content is never stored: the GUI renders the file from disk each time, so a
  restart (or an edit) re-renders it.
- `ThreadService.ShowHtml(thread_id, path, title)` (store `ShowHTML`,
  `internal/store/thread/html.go`) checks the file (absolute, `.html`/`.htm` in any case,
  under home with symlinks followed, a regular file: InvalidArgument; missing: NotFound)
  and appends the item: on the runner's goroutine while the thread runs (a `threadCmd`,
  so it lands inside the running turn, after the Bash call that made it), else straight
  onto the stopped thread's log, like the wake-limit note.
- `thread items` prints it as `page: <path> (<title>)`; `--json` and `thread events`
  carry it like any item.

## Verb

`code-foundry view.inline <path> [--title] [--panel] [--thread]` (category Thread,
NoKeybinding, `When: hasThread`; `commands_view_inline.go`). `--thread` defaults to the
caller's thread (ContextThread). Text result: `shown <path> in thread <name>`; JSON
`{thread, item, path, panel?}`. `--panel` then runs `view.panel.file`'s check and scoped
ShowView for the same file (its PanelResult under `panel`; "and in its side panel", or
the no-window note). `daemon.capabilities --group panel` lists it (text and a JSON
`inline` field) and `pages` no longer counts it; the rendering group's html line names it.

## GUI

- `HtmlFrame` (components/files) is the one frame for the File tab and the inline card:
  same sandbox (never `allow-same-origin`), grant URL, `no-referrer`, `cf:theme` posted on
  load and on theme change. It hears its own frame's `{type: "cf:resize", height}`
  (`event.source` is the frame); the card follows it, capped at 60% of the timeline's
  height, 420px by default (`lib/inlinePage.ts`).
- `InlineHtml.tsx`: the row and card; Expand is a lightbox over the thread pane with the
  same strip (Esc, the collapse button or the scrim closes it); Source swaps the frame for
  the File tab's read-only code view; Save is disabled with "Artifacts come in a later
  release". A missing file or a failed PreviewFile shows the amber "Could not render this
  page." with the reason muted and the source under it (or why it cannot be read).
- Timeline: an `html` node never folds away (its row stays in a folded turn, marked
  "folded", card closed), is no step, and breaks a live strip's run.
- No off-screen frame: a closed card mounts no iframe, the virtualizer drops rows out of
  view, and the lightbox's frame goes with it.

## Decisions

- **A card seen open survives its turn's own fold.** Every finished turn folds when it
  ends while the reader is at the bottom, so a page shown while they watch would close a
  few seconds later. The row records that the reader saw it open (`html-seen:<id>` in
  the thread's expand state); then only the user folding the turn, or leaving the thread
  (which forgets expand state: every folded turn's cards are closed on return), closes
  it. The node carries `foldChosen` for that.
- **Frames reload on a new theme.** A page that only links `/cf/theme.css` fetched it
  once (no-store) and stayed in the old theme. `onThemePublished` (lib/theme.ts) fires
  once the daemon has the new slots; HtmlFrame remounts its iframe when the active slots
  differ from the ones it loaded with (a reconnect's republish of the same theme does
  not). The page's state goes with the reload; theme switches are rare. Applies to the
  File tab too.
- **A new grant after a daemon restart.** Grants die with the daemon; a frame reloading
  on a dead one (the theme reload above, an edit) came back blank. `usePreviewGrant`
  asks again when the daemon's pid changes (not after a blip of the same daemon) and
  keeps the old URL until the new one arrives. Applies to the File tab too.
- **System prompt.** The `ThreadPrompt` clause "a path in your reply is a clickable chip,
  an .html file renders interactively" became "a path in your reply is a clickable chip;
  show .html pages: view.inline <file>" (1429 of the 1430-byte cap). Without it Haiku 5.5
  never loaded the entry skill for "show me a small page … inline" (twice: it pasted a
  fenced block). The skills still say a path chip opens an .html file rendered.
- **Skills at their caps.** Entry (70/70 lines): a routing row "A page, chart or HTML you
  make", and "Showing things" rewritten in the same lines; the panel surface list there
  now names seven surfaces with "…" (linked-prs, agents and workspace dropped:
  `--group panel` lists them). Its description says "asks you to show or make a file,
  diff, page, HTML or chart" (397/400; "which of its other skills to read" became "which
  skill to read"). Help (105/105): the page paragraph names `view.inline`, `--panel` and
  `cf:resize` on load with `document.body`'s height; the status-triple suffixes and "so it
  follows the user's theme" went, and the "dev build" bullet became one line.
- **The guide.** Thread is the guide's detailed category, at its 25,000-byte cap:
  `view.inline`'s description and arg help are short (the capabilities group and the
  skills carry the details), and `--thread` has no suffix help.

## Left out

- Fenced ```html blocks in a reply rendering inline (writing them to a scratch dir): a
  follow-up.
- Save as artifact: the button is there, disabled, until Artifacts exist; no Saved chip.
- Load errors inside the page are not observed (cross-origin frame).
- The mock has the `ShowHtml` RPC and a scripted `html` state (`POST
  /__mock/thread?state=html`), not the `view.inline` command itself.

## Gotchas

- `cf:resize` from `document.documentElement.scrollHeight` can never shrink below the
  frame's current height; measure `document.body`.
- `make gui-e2e`: `panel.spec.ts` "dragging a tab onto its neighbour reorders the strip"
  failed once and passed on rerun (not touched here).

## End to end (2026-10-22, isolated home)

`make gui-build`; daemon and GUI with `CODE_FOUNDRY_HOME=/tmp/cf-inline` and the CLAUDE*
variables unset; a non-git scratch folder `~/cf-scratch-inline` registered. Haiku 5.5
(`claude-haiku-5-5[1m]`, medium, auto) threads asked "show me a small page that says
hello with a button, inline":

- Before the prompt clause (two threads, the second after the description reword): no
  skill loaded, a fenced HTML block in the reply. Without "inline" in the request: a file
  written and named as a path chip. Naming the skill: it loaded, wrote a page linking
  `/cf/theme.css` and ran `view.inline` by itself, so the skill text was right and the
  routing was not.
- After it: the entry skill loaded, `hello.html` written, `code-foundry view.inline
  ~/cf-scratch-inline/hello.html` run unprompted, `#7 page: hello.html` in the
  turn. Follow-ups made it a themed card (`--card`, `--primary`, `--muted-foreground`)
  and sized it with `cf:resize` on load; the card fitted it.
- In the app: the block rendered themed; the card stayed open after the turn ended;
  expand opened the lightbox, source toggled the code view there, Esc closed it; dark to
  light repainted the page; after `kill` of the daemon (the GUI started a new one) and a
  theme switch, the frame rendered again from a fresh grant; after relaunching the GUI
  the items came back from `thread_items`, folded.

The threads, scratch folder and home were removed afterwards.

## Daemon restart

Needed: a new RPC, item kind, command and prompt text, and the skills are rewritten at
daemon start. The GUI and daemon ship together.
