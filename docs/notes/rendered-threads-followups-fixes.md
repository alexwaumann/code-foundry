# Rendered threads: polish batch (follow-ups §0)

Branch `t3code/rendered-threads-followups-fixes`. Decisions from
`rendered-threads-followups.md` §0 (Alex, 2026-10-12). The cache-after-reconnect item
there is an investigation, not part of this PR.

## Composer keeps focus after send

* `ThreadComposer` notes in a **layout** effect whether focus was inside the composer
  when the draft left `idle`. It has to be a layout effect: PromptEditor makes the editor
  read-only in a passive effect, and child effects run before the parent's.
* Back at `idle` it refocuses only if focus is on `body` or still inside the composer, so
  a user who clicked elsewhere mid-send is not pulled back.
* Gotcha (WebKit, so WKWebView): a contenteditable that goes read-only **keeps** DOM
  focus, but after it is editable again typing goes nowhere, and TipTap's
  `commands.focus()` is a no-op on a view that already has focus. So the refocus blurs
  the active element first. Chromium drops focus instead; both paths are covered by e2e
  (Enter and the Send button, then typing).
* The Send button's `mousedown` is prevented, so clicking it leaves the caret in the
  prompt (it used to take focus in Chromium).

## Thread width

* `appearance.thread_width`: compact | comfortable | full, default comfortable, live.
* `applySettingsSnapshot` sets `html[data-thread-width]` (unknown values fall back to
  comfortable, `threadWidthOf`). `thread.css` sets `--thread-col` / `--thread-dock` on
  `.cf-thread` (comfortable 1040/960) and overrides them per attribute: compact 784/720
  (the old values), full `none`. Timeline's 40px row insets inside `.col` are unchanged.
* Gotcha: the wider default made the subagent label in the docked permission header fit,
  which broke an e2e that checks the cut-short tooltip; that test now sets compact.

## Jump to bottom

* A button rendered by `Timeline` as a sibling of the scroller (not in the virtualized
  content), absolutely positioned in ThreadPane's relative wrapper at
  `bottom: max(bottomInset - 20, 12)`: the dock has 32px of gradient padding above the
  composer, so this sits 12px above the card. `z-index: 2` puts it over the dock's
  gradient (the dock comes later in the DOM).
* Shown while `atBottom` is false. Hidden with `visibility` (delayed until the fade ends)
  so it is not clickable and Playwright sees it as hidden; `aria-hidden`/`tabIndex=-1`
  while hidden. Click: `pinned = true` then `toBottom()`.

## Tables

* Scoped to rendered threads; the PR surface keeps `.cf-markdown`'s plain grid. A new
  `MarkdownExtras.table` renderer lets a surface wrap tables; `threadExtras` wraps each in
  `div.cf-table`. The PR surface can opt in with the same extra and CSS later.
* The wrapper carries the frame: 1px border at `color-mix(foreground 14%)`, 8px radius,
  `overflow-x: auto` (which also clips the header fill to the corners). The table is
  `display: table; width: 100%; border-collapse: separate; border-spacing: 0`, with
  right/bottom inner rules only (none on the last column / last row) and `th` filled at
  `color-mix(foreground 5%)`. The nowrap-code and break-word cell rules are unchanged.
* The streaming caret skips `.cf-table` as it skipped `table`.
