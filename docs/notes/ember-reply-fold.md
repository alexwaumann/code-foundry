# Ember's reply fold (2026-10-23)

Follows `ember-3-gui.md` (the chat and its fold), `ember-fixes-1-gui.md`,
`ember-fixes-2-gui.md` and `citations.md`. Frontend only.

Ember (Opus 4.8 high) writes text between tool calls despite a rule not to. Every text item
showed in the chat, so a turn read as many "Worked for" rows between paragraphs, like any
other thread. Ember's text could not be cited (no cite layer, no `data-cite-item`) and had
no Copy answer. Inline pages (view.inline) and theme cards went into the work fold.

## The fold rule (`lib/ember.ts`: `replyTexts`, `buildEmberRows`)

A top-level `text` item is visible (the reply) only when it is the **last text of its
turn** and one of these holds:

- the turn has ended: a `turnEnd` follows before any later user message (a wake included);
- the turn waits on the user: a pending question or pending permission follows (a
  standalone permission, or a tool whose permission is pending), with no `turnEnd` between.

Every other text joins the current run, as a tool call does:

- text written between tool calls;
- a second-to-last text;
- a text a later message follows before the turn ends;
- the trailing text of a live turn.

`replyTexts` computes this in one backward pass:

- a turn end or a pending prompt marks "closed";
- a user message clears it;
- a text is the reply when "closed" is set, and then clears it.

Other rules:

- **Pages and theme cards** (`html`, `theme`) are visible. They render through the thread's
  row views (`HtmlRow`, `ThemeCardRow`), with an `html` row's `folded` set to false.
- They close the run, as any visible row does.
- They do not count as the reply: a text, then a page, then a turn end keeps the text as the
  reply.
- Unchanged: the pending-permission tool row, restart cuts, wakes, quiet runs, the live
  "Working" row and run keys.
- A turn's text with nothing after it yet is in the live run, under the live row.
- `workSummary` says nothing about the folded texts. There is no "wrote N notes": a user
  asked for no phrase.

**No streaming.** A reply does not stream in Ember's chat. It appears when its turn ends:
until the turn end arrives, the text could still be a note between tool calls. This is
deliberate. An open run still streams its texts.

## Separate from ThreadBody

`EmberBody` / `EmberTimeline` / `buildEmberRows` stay a separate renderer from
`ThreadBody` / `Timeline` / `buildRows`. That was decided: Ember's chat will diverge, and a
shared shell or row builder is not wanted. Only leaf mechanics are borrowed:

| Leaf mechanic | Where | What Ember gets |
|---|---|---|
| `TextRow` (`components/thread/rows.tsx`) | the reply is a `{type: "text", final: true, answer: <its id>}` row; a folded text in an open run is the run's plain text row | `data-testid="thread-text"`, `data-final`, `data-cite-item`, Copy answer (this text only), code actions (Run in terminal), streaming |
| `TextMarkdownContext` (`components/thread/context.ts`, new) | `EmberTimeline` provides `emberMarkdown` | `TextRow` renders a finished text's markdown through it: `splitTaskLinks` + `TaskPointer`, so task links are pointer lines in replies and in folded texts alike. Null elsewhere (ThreadMarkdown). |
| `CiteLayer` | mounted in `EmberBody`, `bodyRef` on the body div as in `ThreadBody`, keyed `cite:<id>` | select → Cite → comment → chip; chip edit and Go to source |
| `TimelineList` | new `citable` prop (defaults to `turns`) and `unfold` | registers the list with the cite store (`registerTimeline`); rows are keyed by item id, so `showRow` works |
| `HtmlRow`, `ThemeCardRow` | via `TimelineRowView` | inline pages and theme cards |

`EmberText` is gone. The e2e uses `thread-text[data-final]` for Ember's replies instead of
`ember-text`.

**Go to source** on a folded text: `TimelineHandle` gains an optional `unfold(itemId)`.
When `showRow` misses, `revealQuote` calls it instead of the thread's turn unfold. Ember's
version (`unfoldIn`) opens the work row whose ids hold the item, as the user's own choice
(`setRowExpanded`).

**One registered list per thread** still holds: a thread shows in one body at a time.
`WatchedThread` routes Ember's thread to `EmberBody`, never to `ThreadBody`. Comments in
`stores/cite.ts` and on `EmberTimeline` say so.

## Checklist: mirror thread features by hand

When a thread feature lands in `ThreadBody`, `Timeline` or `buildRows`, check whether Ember's
chat needs it too:

- a new item kind: decide visible or work in `buildEmberRows`' `visible`, and whether it
  closes a run or can be the reply;
- a new row type: `estimate` and `renderRow` in `EmberTimeline.tsx`;
- a body-level layer like `CiteLayer`: mount it in `EmberBody`;
- a `TextRow` change: it reaches Ember through the reply row; check `TextMarkdownContext`
  still wraps what it renders;
- a `TimelineList` change gated on `turns`: decide whether Ember (`turns` false) needs it.

## Mock and tests

- `mock/emberChat.ts`, section 1: a note between the reads and the workers' start ("…so both
  can start now."). It is folded into the third run. The run count and summaries are
  unchanged.
- `lib/ember.test.ts`: a table over the fold rule:
  - text, tool, final text;
  - a live turn's trailing text;
  - the same with no turn end, not working;
  - text before a pending question;
  - text before a tool waiting on a permission;
  - two texts before a turn end;
  - a reply, its turn end, then a wake;
  - a later message before the turn end;
  - a page closing a run;
  - a page after the reply;
  - a theme card between texts.

  It also checks the reply's and the page's row shapes. Two older cases gained the turn
  ends the new rule needs.
- `e2e/ember.spec.ts`:
  - the note hidden and the reply shown;
  - the note shown in its open run, not final, with no Copy answer;
  - the reply's Copy answer and its two task links;
  - citing the last reply (chip `the worker is still…`);
  - citing the folded note in its open run, closing the run, then the note's chip opening it
    again (`unfold`).
- `textPoints` / `dragSelect` moved from `citations.spec.ts` to `e2e/fixtures.ts`, shared.

## Gotchas

- The React compiler's lint (`react-hooks/static-components`) rejects a component taken from
  context and rendered as `<Markdown />`. The context holds a render function instead.
- `ember.spec.ts` "the board's sections…" fails between local midnight and about 02:00. The
  mock's cancelled task is `updatedAt: ago(120)`, which is yesterday then, so Done today
  lacks it. This was seen in this PR's run at 01:3x. It is time-of-day only and not this
  change.
- Another worktree's mock held ports 7799/9255. The runs used `E2E_MOCK_PORT=7861
  E2E_VITE_PORT=9361`.
