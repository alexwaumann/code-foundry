# Rendered thread: timeline + follow-up composer

> Copied from `/tmp/cf-thread-sketch` by rendered threads PR 2. Only variant A's screenshots
> (`shots/a-*.png`) are kept; the fonts load from `gui/frontend/public/fonts`, and
> `shoot.mjs` was not copied. Open `index.html?variant=a&theme=dark|light&state=…`.

This is a static sketch of the opt-in "rendered" thread mode described in
`docs/notes/rendered-threads-handoff.md`. The main pane shows one thread, "Fix stale PR
badge", inside mocked app chrome: the sidebar, the thread header, and a follow-up composer
at the bottom. It has three variants, and Alex picks one before PR 2 starts.

```
index.html?variant=a|b|c&theme=dark|light&state=permission|question|streaming
```

* `state=permission` (default): turn 2 is waiting on a Bash permission prompt
  (`git push --force-with-lease …`).
* `state=question`: turn 2 is waiting on an AskUserQuestion prompt with 2 questions.
* `state=streaming`: only turn 1 exists, and its final answer is still streaming (a caret
  inside the Go block plus a "Working 3m 52s" row).

You can click any row to expand or collapse it. The page loads scrolled to the bottom, the
way a live thread does.

## Thread content (same in every variant)

* Divider: "Earlier turns ran in the terminal" with an *Open transcript* link. It marks a
  thread that switched from terminal to rendered mode (decision 3).
* User message. It contains a green image chip, the blue `poller.go` file tag and the
  purple `/tdd` skill tag, styled exactly like the composer's tags (`tagStyle.ts`).
* Collapsed thinking row: "Thought for 9s".
* Explore groups, labelled the way T3's `presentation.ts` does it:
  * One collapsed group: "Read 3 files, searched code 2 times".
  * One expanded group with three member rows. Its Grep row is expanded too and shows the
    matches, with highlighted hits.
* Answered AskUserQuestion, shown as one row: "Asked [Fix approach] Head SHA in the
  fingerprint".
* Edit rows:
  * A collapsed Edit row (`+18`).
  * An expanded Edit row with an inline unified diff. It has a hunk header, old and new
    line numbers, +/− gutters, a word-level highlight on the added `HeadOid` line, and
    syntax colours.
* Bash rows:
  * An expanded Bash row: the highlighted command, then the failing `go test` output, and
    an `exit 1` chip.
  * A collapsed Bash row with an `ok` chip.
* Agent (Task) row, expanded. Its nested child rows hang off a guide line, followed by
  the subagent's result text.
* Final answer in markdown: h2/h3, a list, inline code, a link, a GFM table and a
  highlighted Go block.
* Turn footer: duration, cost and model, plus a copy button.
* Turn 2: user message → a passing suite → a pending prompt. While the turn is busy the
  composer shows **Interrupt** next to Send.

The pending prompts work like this:

* **Permission prompt**:
  * It shows the tool chip (`Bash`), the command with highlighting, the CLI's description,
    and what *Allow for session* adds (`Bash(git push:*)`, taken from
    `permission_suggestions`).
  * Buttons: **Allow / Allow for session / Deny**, numbered 1/2/3 to match the TUI's
    muscle memory, plus **Interrupt** (deny with `interrupt: true`).
* **AskUserQuestion**:
  * It shows a pager ("1 of 2") and the question's `header` as a small chip.
  * The options are radio rows with their descriptions, numbered, plus "Other" with a
    text field.
  * Buttons: Next, Skip questions, Interrupt.

## Language (nothing new invented)

* **Tokens** come from `index.css` (`:root` and `.dark`): sheet, pane, pane-border,
  border, muted, primary, radius.
  * Status tones are the Tailwind colours the sidebar and PR surface already use: sky =
    working, amber = needs input, emerald = ok, red = failure.
  * The header and sidebar status strings are the existing ones ("needs attention",
    "Needs input · Bash", "Working · …").
* **Markdown** uses the `.cf-markdown` rules from the PR surface, copied as they are.
* **Syntax colours** (code, diff, shell) are the xterm palette in `src/terminal/theme.ts`
  (One Dark-ish in dark, GitHub-ish in light). The rendered code therefore looks like the
  terminal it replaces, with no new palette.
* **Composer** is the `ComposerCard` look:
  * a rounded-2xl `bg-card/85` frosted card;
  * ghost xs pickers (Model / Effort / Permissions);
  * a paperclip, and a round primary send button.
  * The worktree row is dropped, since the thread already exists.
  * Interrupt is an outline pill in the send column.
* **Diff tints** are emerald-500 and red-500 at about 11%, the same mix strategy the tag
  chips use (`color-mix` with transparent).
* **Fonts**: the UI uses the system stack from `index.css`. All mono (code, diff, commands,
  paths) uses the bundled **JetBrainsMono Nerd Font Mono**, loaded from the repo's TTFs.
  * Note: `.cf-markdown code` in the app currently uses `ui-monospace`. If we keep the
    bundled font here, the rendered thread should override that (or `.cf-markdown` could
    switch to it, so PR bodies match).
* **Icons** are lucide, the same names the app imports, extracted from its lucide-react
  build. The Claude mark is `icons/ClaudeMark.tsx`.

## Variants

### A: dense work log, prompts docked in a floating composer (T3-like)

* Column is about 704px of content.
* User messages are right-aligned bubbles. Assistant text runs full width with no avatar.
* Every tool call is a 24px row: a muted icon, a verb + target label, meta and a chevron.
  Consecutive reads and searches fold into one sentence row.
* The composer card floats over the bottom of the timeline on a fade.
* A pending prompt docks into the **top of the composer card**: the card turns opaque, and
  the prompt sits above the prompt editor. The timeline keeps a one-line placeholder row
  where the tool call is ("Run git push … *waiting for you*").
* The turn footer is a hairline with "Worked for 4m 08s · $1.12 · Opus".

Pros:
* Densest of the three: about twice as much history per screen as B.
* The prompt sits exactly where the eyes and hands already are (composer, 1/2/3 keys). It
  never scrolls away, and it cannot be missed after a long stream.
* It is proven: T3's structure (`WorkLog`, `ComposerPendingApprovalActions`), so the
  presentation logic in `client-runtime/work-log` lifts across almost unchanged.

Cons:
* A tall AskUserQuestion (4 options + Other) takes about 450px of the pane.
* With a prompt pending there are two Interrupt buttons: the prompt's and the composer's.
  Suggest dropping the prompt's in A, because the composer's does the same job one row
  lower.

### B: chat, process folded under each turn, docked composer

* Wider column (about 824px), 14px body text.
* Each assistant turn has a role line: the Claude mark in a ring, "Claude · Opus · high ·
  14:02".
* Under it sits **one indented work log per turn**, with a fold header: "Worked for 4m 08s ·
  14 steps · 9 files read · 1 edited" when done, or "Working" / "Waiting for you" when live.
* The log holds thinking, intermediate text (muted) and every tool row behind a guide line.
* The final answer comes after the log, full contrast at 14px. Footer: cost and tokens.
* The pending prompt is an amber-bordered card **inline in the log**, at the tool's
  position.
* The composer is docked below a border instead of floating.

Pros:
* Reads like a conversation. Folding a finished turn's log (the natural default once the
  turn ends) leaves only questions and answers, which is great for long threads.
* The prompt shows next to its context.

Cons:
* The role lines and fold headers add chrome.
* The docked composer costs about 150px of pane height.
* An inline prompt can scroll out of view while text streams elsewhere, so it would need a
  "jump to prompt" affordance.
* Intermediate text gets demoted to muted, which sometimes hides useful reasoning.

### C: rail (the PR surface's timeline language)

* Every item is a node on a vertical rail, reusing `PrTimeline`'s rail and round
  pane-coloured node slots:
  * "You" (person node, message in a tinted card);
  * Claude text (orange mark);
  * tool rows (their icon moves onto the rail);
  * "Turn finished" (emerald check);
  * the pending prompt (pulsing amber dot plus an inline amber card).
* The composer floats as in A.

Pros:
* Matches an existing surface in the app.
* The rail makes "who did what, in what order" scannable, and the amber node is easy to
  spot when scrolling.

Cons:
* The rail costs 34px of every line.
* At tool-row density the line and nodes become visual noise. It suits sparse PR events
  better than 30 tool calls a turn.
* An inline prompt has the same scroll-away problem as B.

## Recommendation: A

A is the right default for a fleet tool, where the user mostly glances at a thread to see
what it did and to unblock it:

* Most history per screen.
* The prompt is always at the composer and keyboard-first.
* The closest to T3, so PR 2 and PR 3 can lift `work-log/presentation.ts`, the grouping
  and the label logic with the least design work.

Two ideas worth taking from the others:

1. **From B:** make A's turn footer a fold toggle. Clicking "Worked for 4m 08s" collapses
   that turn's work rows, so the answer stays and the process folds away. Default: expanded
   for the live turn, collapsed for earlier turns once a thread runs past a few screens.
   This can wait for PR 4.
2. **From C:** if a prompt is docked in the composer and the user has scrolled up, the
   timeline's "waiting for you" row stays amber. A sidebar row and the header dot already
   carry the state, so no extra affordance is needed.

Open points for Alex:
* Drop the prompt-row Interrupt in A (keep only the composer's)?
* Use the bundled mono font for code in the thread (sketched) or keep `ui-monospace` like
  the PR markdown?
* Should collapsed turns be the default for older turns?

## Files

* `index.html`, `thread.js` (content + the three layouts), `style.css` (tokens + shared
  pieces), `variants.css`, `icons.js` (lucide paths), `fonts/` (bundled TTFs).
* `shoot.mjs`: Playwright WebKit at 1440×900 @2x. Run it with `node shoot.mjs [a,b,c]`;
  it imports `@playwright/test` from the main checkout's `gui/frontend/node_modules`.
* `shots/<v>-<theme>.png` is the default state at 1440×900, scrolled to the bottom. Each
  also has these companions:
  * `-full.png`: the whole thread;
  * `-diff.png`: crop of the expanded Edit;
  * `-permission.png`: crop of the prompt (in A, the whole composer card it docks into);
  * `-question.png`: the AskUserQuestion state;
  * `-streaming.png`: the streaming state.

## Decisions (Alex, 2026-10-11)

Variant A, with B's turn fold (finished turns collapse their work rows under the footer,
latest turn open, only the final assistant message visible by default) and C's amber
emphasis on the "waiting for you" row. Only the composer's Interrupt button. Bundled
JetBrains Mono for code/diff/shell. Remove the "Earlier turns ran in the terminal"
divider: a thread's render mode never changes.
