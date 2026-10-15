# Theme 3: every tooltip is the shadcn Tooltip

Third of five PRs towards a theme engine (tokens, palette sweep, tooltip sweep, form
controls, radio-group + cleanup). WebKit's native `title` tooltip is sharp, anchored to
the cursor and ignores the theme; after this PR the app has none. Every tooltip is the
shadcn `Tooltip` (Radix), drawn with the popover tokens, anchored to its element and
scaled with the page zoom. Frontend only.

## Counts

`title=` in non-test `.tsx` under `gui/frontend/src`: 138 lines in 54 files before, 20 in 6
files after, all of them a component's own visible text (the guard's allowlist below).
Plus one DOM write (`el.title = …` in `PendingPrompt.tsx`), now gone. `<Tip` appears 95
times in 51 files.

Of the 118 native tooltip sites, 14 are deleted (list below) and a few narrowed; the rest
are a `Tip`: 92 `<Tip>` elements in components plus NavRow's `tip` prop (5 row kinds) and
the PR timeline's commit entries. 22 of them open only while the text they repeat is cut
short (`whenTruncated`).

## The helper: `Tip`

`components/ui/tooltip.tsx` keeps the shadcn parts (`Tooltip`, `TooltipTrigger`,
`TooltipContent`, `TooltipProvider`) and adds `Tip`:

```tsx
<Tip label="Close tab"><button …/></Tip>
<Tip label={path} align="start" whenTruncated><span className="truncate">…</span></Tip>
```

- One child, wrapped with `TooltipTrigger asChild`: the child stays the element, so it
  must take a ref and spread props (shadcn `Button`, a DOM element, a Radix trigger with
  `asChild`, TipTap's `NodeViewWrapper`).
- Content: the existing wrapper (`rounded-lg border bg-popover shadow-lg`, zoom-scaled
  offsets) plus `max-w-80 px-2.5 py-1.5 text-xs break-words whitespace-pre-line`, the
  size the MCP and tag tooltips already used; `"\n"` in a label breaks the line (commit
  sha and author). `side` (default top; Radix flips at the window edge), `align`,
  `sideOffset`, `className`, `data-testid` pass through.
- No label (`null`, `undefined`, `false`, `""`): it never opens, but the trigger stays
  wrapped, so a label that comes and goes (the composer's send button while it sends)
  does not remount the button and drop its focus.
- `whenTruncated`: opens only while the trigger or an element inside it overflows its box
  (`scrollWidth > clientWidth` or the height for `line-clamp`; an `sr-only` label counts,
  being 1px wide). That is the rule "a tooltip only for what is hidden" for names that
  are visible until a narrow pane cuts them.
- **Focus.** Radix opens a tooltip on any focus. A closing dropdown hands the focus back
  to its trigger and a dialog gives it to its first button, so "More actions" or "Close"
  popped up away from the pointer. `Tip` controls `open` and refuses an open while the
  trigger holds the focus unless the trigger is hovered or the focus came from a
  navigation key (Tab, arrows, Home, End) in the last 500 ms; any other key or a pointer
  press forgets it. Hover opens as before.
- **Press.** Radix cancels only a tooltip already showing on pointer down; one still in
  its delay opened after the click, over the menu the click opened (and then took the
  menu's Escape, failing `projects.spec.ts`). `Tip` stays shut after a press on (or
  inside) its trigger until the pointer leaves.
- **Nesting.** Radix closes other tooltips when one opens, but a row's tooltip and a
  count's inside it, entered by the same pointer move, end their delays together and
  both stayed open. A `Tip` does not open while a nested `Tip` trigger (`[data-tip]`) is
  hovered.
- **Escape.** An open tooltip is Radix's topmost dismissable layer and only the topmost
  layer listens for Escape, so with a tooltip open in a menu, Escape closed the tooltip
  and left the menu (seen live). `Tip` sends the Escape on to the focused element once
  the tooltip has unmounted (two frames later, when the menu listens again), so a tooltip
  never swallows a key.

The thread row tooltip (`SidebarRow` `ThreadTooltip`) and the composer tag tooltips
(`TagView`) keep their own `Tooltip` markup (richer than a label); the MCP hint icons now
use `Tip`.

## Provider

One `TooltipProvider` (delay 500 ms, Radix's 300 ms skip delay) wraps the app in
`App.tsx`, so moving from one trigger to the next opens the next tooltip at once anywhere
in the window. Removed: the sidebar's (`delayDuration={500}`, the same), the prompt
editor's (default) and the MCP panel's (`delayDuration={300}`; no note or commit says why
the hint icons should be quicker, and a nested provider has its own skip-delay state).

Unit tests: Radix throws outside a provider, so `src/test/setup.ts` wraps every
`@testing-library/react` `render` in a `TooltipProvider` (a test can pass its own
`wrapper`). `src/test/tooltip.ts` `tooltipText(el)` opens one the keyboard way (Tab, then
focus) and reads it.

## CommandButton

`CommandButton` renders an icon-only button inside `Tip` with the command's title (or its
`tooltip` prop, renamed from `title`; `aria-label` unchanged). A button with a label or
custom content has no tooltip. Unavailable with `whenUnavailable="disable"`, the button
is `disabled`, which in WebKit and Chromium means no pointer events, so the tooltip hangs
on an `inline-flex` span around it (Radix's documented pattern) and still shows. Every
toolbar (sidebar toolbar and status bar, thread header, panel toggles, side panel "+")
comes with it.

Other disabled buttons with a tooltip do the same: the composers' attach and send
buttons, the MCP refresh, the Action dialog's Save (its reason), the PR surface's Code
tab, `RowAction` while disabled, and a PR check without a URL (the `li` is the trigger).
Buttons that are `aria-disabled` rather than `disabled` (sidebar notifications, merge)
keep their hover and need no span.

## Menus and other Radix triggers

`Tip` goes outside a `DropdownMenuTrigger`/`PopoverTrigger asChild`. Both set
`data-state` on the shared element and the tooltip's wins (Slot gives the outer props to
the inner trigger, which spreads them last), so `data-[state=open]:bg-accent` on a menu
button stopped matching. Those buttons now style the open state from `aria-expanded:`
(Radix sets it on menu and popover triggers): `OverflowMenu`, `ActionsMenu`, `PrMenu`,
`ReviewerPicker`; the Projects page's `has-[[data-state=open]]` reveal of a row's actions
is `has-[[aria-expanded=true]]`. The publish visibility radio items style checked from
`aria-checked:` for the same reason. `ProjectSwitcher` keeps `group-data-[state=open]`
because its title was deleted (no Tip on that trigger).

Inside menus, as asked, no exception: the Actions menu's per-item edit button, the PR
menu's Refresh hint (the last fetch's error) and the merge menu's label (`Merge into
<base>`, when cut) are `Tip`s inside the menu content. Radix opens one tooltip at a time
(a tooltip opening closes the others), so a nested trigger (a count inside a row with a
path tooltip) shows only the inner one while hovered. No spot needed deleting because it
could not host a tooltip.

## Deleted titles

| Where | Title | Why |
| --- | --- | --- |
| `SidebarRow` workspace badge | `Workspace X: show its members in the side panel` | click instruction; the badge shows the name |
| `SidebarRow` linked-PR badge | `N PRs linked: show them in the side panel` | click instruction; the badge says it |
| `SidebarRow` `row-moving` | `Runs in X once it is idle at its prompt` | moved, not lost: a `tip-moving` line in the thread tooltip (a nested tooltip in the row would fight it) |
| `SidebarRow` "No git" badge | `Not a git repository: …` (`NoGitBadge tip={false}`) | the thread tooltip already says "no git" |
| `DaemonStatus` syncing | `Not streaming: events` | repeats "syncing events…" |
| `PullRequestsPage` rows | the PR URL | repo and number are on the row |
| `PullRequestsPage` scope toggle | `Switch between registered and all repositories` | click instruction on a labelled button |
| `WorktreeOverview` check and PR rows | the URL | as above |
| `LinkedPRsSurface` rows | the URL | as above (the e2e already asserted no title) |
| `PullRequestSurface` repo link | `Open <url> on GitHub` | the slug and number are the link's text |
| `PullRequestSurface` timeline count | `N timeline entries` | repeats "N entries" |
| `Composer` thumbnail | `Open preview` | click instruction |
| `AttachmentChip` | `Open preview` (a removed image keeps `name (removed)`) | click instruction |
| `ProjectSwitcher` | `Change project` | click instruction on the project's name |

Narrowed: a PR check's tooltip drops the URL (name and description stay); the order
toggle drops "(click to reverse)" and shows only when its label is `sr-only`; the full
`ChecksBadge` label shows only on the compact (icon-only) badge; a reviewer chip without
a review state has none (it would repeat the login).

## Guard

`src/lib/tooltips.test.ts` (sibling of the palette guard) reads every non-test `.tsx`
and fails, with file:line and the tag, on:

1. `title=` on a DOM element, or on a component not in `OWN_TITLE`. The tag is found by
   walking back to the opening `<`, skipping `{…}` (so arrow functions and multi-line
   props are fine; a test pins that);
2. `title:` in a JSX spread (`{...{ title }}`);
3. `el.title = …` (not `document.title`) or `setAttribute("title", …)`.

It also fails on a stale allowlist entry. `OWN_TITLE`, components whose `title` is their
own visible text:

| File | Component | What |
| --- | --- | --- |
| `overview/WorktreeOverview.tsx` | `Section` | section heading |
| `pr/PrSummary.tsx` | `Section` | collapsible section heading |
| `pr/PrMenu.tsx` | `Item` | menu item label |
| `prs/PullRequestsPage.tsx` | `PrTable` | table heading |
| `pr/PullRequestSurface.tsx` | `Centered` | empty-state heading |
| `start/StartPage.tsx` | `Header` | the page greeting |

`DialogTitle`, `CommandView.title`, `ConfirmRequest.title` and the like are not `title=`
attributes and never match. `.ts` files are not scanned for `title=` (no JSX).

## Keyboard rows and e2e

The listbox rows (sidebar, Projects, Pull Requests, overview, linked PRs) are not
focusable (`aria-activedescendant`), so arrow keys never open a row's tooltip; the
sidebar's arrow-key and context-menu specs are unchanged. The bottom panel's and side
panel's tab strips are real focus targets: arrowing across tabs shows each tab's cwd,
which is what a keyboard user should get.

Specs that read `title` now hover and read the open tooltip (`e2e/fixtures.ts`
`expectTooltip`, `openTooltip`, `expectNoTooltip`): actions, bottom-panel,
code-block-actions, compose, mcp-panel (a selector), panel, pr-panel, projects, sidebar,
snooze, terminal-routing, thread-prompts. Asserting the deleted "Open preview" titles is
gone. `actions.spec.ts` also checks that Escape with the edit button's tooltip open
closes the menu. `expectTooltip` moves the pointer off first: after a click on the same
spot no tooltip opens until the pointer leaves (Radix, and `Tip`'s press rule).

## Gotchas

- Radix 1.2 puts `role="tooltip"` on the content itself (no visually hidden copy without
  an `aria-label`), so `getByRole("tooltip")` reads the label once.
- A tooltip closing keeps its content mounted for the fade with `data-state="closed"`:
  e2e looks for `[data-slot="tooltip-content"]:not([data-state="closed"])`.
- jsdom has no layout: `whenTruncated` tests fake `scrollWidth`/`clientWidth`.

## Verified

- `make check` before rebasing onto main (#112, #113); after it the frontend half is
  green and the Go half fails locally on
  `TestRenderedSetEffortGap/the_new_process_never_answers_its_handshake` (3 of 3 runs,
  load average 12). No Go file differs from main and main's CI is green: a timing flake
  on this machine, not this PR.
- `make gui-e2e` (WebKit + Chromium), after the rebase: 762 passed, 40 skipped, 0 failed
  (the known `panel.spec.ts` Chromium flake did not show). Rebased once more onto #115
  (the Help overlay's Guide tab; its shortcut rows keep their `Tip`): frontend checks
  green, and the help, settings, start, sidebar and buttons specs pass (74). The first run had failed on the nested
  row/count tooltips and the late open over a menu, which the press and nesting rules fix.
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`, a Haiku thread in a scratch repo
  whose origin is the GitHub repo): the sidebar status bar's Command Palette button, the
  thread header's Archive Thread (flips below at the window top), a Pull Requests row's
  age (full timestamp, shifted in at the window edge), the daemon status (cut "pid 122…"
  shows "daemon · pid 12214 · dev · up 5m 41s"), the Play menu's per-action edit button
  inside the open menu, the side panel tab's close button and the worktree path; dark
  and light; at 125% zoom (cmd+= twice) the PR age and palette tooltips stay anchored
  with scaled gaps. The Play trigger shows its open state from `aria-expanded` and no
  tooltip pops over the open menu; Escape with the edit tooltip open closes both.
  `theme-3-tooltips/dark.png`, `light.png`.

## PR 4 (form controls)

- Switch, checkbox, select and radio-group from shadcn set `data-state` on their root.
  Wrapping one in `Tip` overrides it, so style them from `aria-checked:` /
  `aria-expanded:` / `data-slot`, or put the `Tip` on a label or wrapper, not on the
  control. Disabled controls need the span wrapper too.
- The Settings reset button and the Action dialog's Save carry `Tip`s already; the
  migrated inputs should keep them as they are.
- `PublishPicker`'s visibility radio items (hand-rolled on `RadioGroupPrimitive`) now
  style checked from `aria-checked:`; the shadcn radio-group (PR 5) can take that over.
- Validation messages (Save's reason) are tooltips today; if the new form controls show
  inline errors, the Save tooltip can go.
