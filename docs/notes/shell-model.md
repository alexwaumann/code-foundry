# The shell: spaces, panes and linked surfaces

The agreed model for the window shell that replaces the main pane, the side panel and the bottom
panel. It was settled over six throwaway prototypes and two rounds of in-app sketches. This file is
the specification the build works from: a change to behaviour changes this file first.

The work lands on the `shell` branch as a series of pull requests and reaches `main` in one merge,
when the first working version is whole. Nothing partial is released.

## Words

- **Space**: a named layout with its own thread list. The top bar switches between spaces.
- **Pane**: one tile of a space. It has a tab strip.
- **Tab**: one surface in a pane.
- **Surface**: what a tab shows: a thread, a diff, a file, a pull request, a terminal, the Pull
  Requests page, the Projects page, and later a plugin's.
- **Linked surface**: a surface that belongs to a thread (its diff, its files, its pull requests,
  its terminal tabs).

## Structure

- **Top bar**, always visible, laid out on its own (no alignment to the sidebar): app name, sidebar
  toggle, back and forward, then the space tabs, then "+". A space tab shows a small icon drawn from
  that space's real pane layout, its name, and a count when threads in it need the user. Nothing
  between the sidebar toggle and back and forward comes and goes: they never move.
- **A space** owns a pane layout and a thread list. A thread lives in exactly one space. Archived
  threads are shared by all spaces.
- **Panes** tile the whole content area: no operation leaves a gap. The layout is one tree of
  proportions; resizing the window only scales it, and there are no per-display snapshots.
- **Any surface can be a tab in any pane.** Tabs drag to reorder, to another strip, or to a pane's
  edge to split. A whole pane drags by its strip: onto an edge, onto another strip to merge, onto the
  outer edge of the grid, or onto a space tab. Any tab is draggable, active or not. Over a pane's
  body, each of its four edges is a drop zone a third of the body deep (at most 320px for left and
  right, 260px for top and bottom), and the middle that is left adds to the pane. The grid's outer
  edge is a thin band of its own (10px inside, 24px outside). A drop on a
  pane's edge splits that pane in half; a tab or pane dropped on the grid's outer edge takes its
  kind's default size (a pane's: its active tab's kind) as a share of the grid along that axis,
  raised to the kind's pixel floor while the rest keeps room. A pane that is joined is never resized.
  While a drag is on, the highlight is the rectangle the tab or pane will be drawn at after the
  drop, minimums held and rails folded as they will be then: on a pane's middle or a rail too (the
  pane takes the dropped tab and the focus, so a rail opens). A place in a strip shows its bar.
- **The focused pane is marked**: its border takes a tint of the theme's accent colour. Only one
  pane has it, and it moves with focus.
- **The tab is the title.** The active tab shows its full name; others may shorten. A tooltip shows
  only a name that is cut off. Tabs go icon-only when the strip is tight. What a surface repeats in
  its own body is decided per surface; do not stack a second title band under the strip by default.
- **Pull Requests and Projects are surfaces**, not sidebar rows. One of each per space.
- **The composer** is a tab. Each space has at most one EMPTY composer: New thread focuses it if
  the space has one, and otherwise opens one in the focused pane. Sending from a composer turns it
  into the thread's tab.
  - **Drafts.** Once something is typed, the composer is a draft with its own identity: New thread
    then opens another, empty composer, so a space can hold several drafts. A draft that is emptied
    again is the space's empty composer again (if the space already has another empty one, the one
    without focus closes). Drafts and their text survive a restart.
  - **In the sidebar**, a space's drafts are listed at the top of Active, below the pinned threads,
    and are drawn so that they read as drafts: a light amber tint behind the row at all times (not
    only on hover), stronger on hover. A click focuses the draft's tab, or opens it in the
    focused pane when its tab is closed. Closing a draft's tab keeps the draft; the row can discard
    it. The empty composer is not listed.
  - An empty composer that is the only tab in its space is ephemeral: opening a thread replaces it.
    Once the space has other tabs or panes, it stays when focus moves away. A draft is never
    replaced.
- **Removing a space** always drops its tabs and panes and ends its unlinked terminals. A dialog asks
  what to do with its threads: move them to another space (they appear in that sidebar, nothing
  opens) or archive them all. A moved thread is closed as closing its tab closes it: its linked tabs
  in the space join its remembered set, its terminals keep running, and they come back, placed
  fresh, when it is opened in its new space. Archiving them ends their terminals, as any archive
  does. The last space cannot be removed.
- **A pane's "+"** opens a menu of surfaces, built with the app's existing dropdown and submenu
  components. With a thread tab active it has a submenu for that thread's surfaces, then the general
  ones (new thread, terminal, Pull Requests, Projects). Without a thread it has only the general
  ones. The choice always opens in that pane, except that a linked surface which is already open is
  focused where it is.
- **Small windows.** Every pane has a minimum size by the kind of its active tab: a thread or a
  composer 360×220px, a terminal 240×110, a diff, file or pull request 260×150, anything else
  300×160. When the panes cannot all keep theirs, panes fold, by one rule for widths and heights:
  - **What a fold looks like.** A pane folded in a row is a rail 36px wide and as tall as its place;
    a pane folded in a column is a strip 36px tall and as wide as its place. Both show the tabs'
    icons, mark the selected one and carry the attention dot; a click on an icon unfolds the pane on
    that tab. A column is narrower only when every pane in it folds, and a row is shorter only when
    every pane in it folds.
  - **Which fold, in what order.** Panes without a thread tab first, then panes with one; within
    each, the least recently focused first (never focused before any that was, and among equals the
    later in layout order). The focused pane and the pane holding the focused tab's thread's tab
    never fold.
  - **How far.** Panes fold in that order until every open pane keeps its minimum. A fold counts even
    when it does not help on its own (the first pane of a column folds before the column can narrow).
    Then the folded panes, the last folded first, unfold again wherever the rest still keep their
    minimums. So an open pane is never narrower or shorter than its kind's minimum while another pane
    could still fold.
  - **When folding is not enough.** If even the panes that never fold cannot keep their minimums
    with every other pane folded, those (at most two: the focused pane and its thread's) share what
    is left in proportion to their minimums, so each falls short by the same fraction; no other pane
    is drawn short (one that would be stays folded), and the grid never scrolls or spills. Chosen
    because those two are what the user is looking at, a surface and the thread it belongs to, and
    folding the thread's pane as well would hide the one the user asked to keep; at the window's
    minimum size with the default sidebar the shortfall is small (a thread and a diff beside one
    folded column: about 6%).
  Rails unfold when there is room. The stored layout does not change. A thread's pane left narrower
  than a thread's minimum keeps its header on top: what does not fit under it (the composer too) is
  cut, never drawn over it.
- **Full screen** (one pane over the whole pane area): the top bar and the sidebar stay. Pane focus
  and move keys do nothing while it is on. Escape leaves it from anywhere but a terminal (the shell's own Escape;
  cmd+shift+enter leaves from there), a menu or dialog, and a prompt that has a use for the key: an
  open completion or history card, dictation, or the floating composer (which collapses first). An
  empty composer's Escape back to its project's page waits until full screen is off. When the tab is a linked surface, the thread's own composer
  floats over it: collapsed to a pill, expanded on demand, with the thread's chip centred above it.
  The pill and the chip are one button: a click toggles collapsed and expanded, and a press that
  moves drags it, in either state, without toggling. It has no other collapse control. It always
  opens at the same spot; a drag lasts until full screen ends; the draft is kept per thread.

## Linked surfaces

- A linked surface is an ordinary tab. Its title is its own name. A quiet row under the strip names
  its thread ("Diff of ● thread") and is the link back; a hover on the tab names the thread too. Names
  are always looked up from the thread id.
- **Identity.** Each surface type says what makes two of its tabs the same, and opening one that is
  already open focuses it: a diff is one per thread and checkout (a workspace thread has one per
  repository), a pull request tab one per pull request, a file tab one per path. "New terminal" always
  makes a new tab. The quick terminal is one per thread.
- **Live and dormant.** The link is by thread id and never needs repair. It is live while the thread
  is open in the same space: smart swap, closing with the thread, and restoring apply. Otherwise it is
  dormant: the row still names the thread and takes you to it. A linked tab may be dragged to another
  space by itself and waits there.
- **Placement** of a linked surface opened by a key, a menu or the palette, in order:
  1. It is already open in this space: focus it.
  2. A pane holds this thread's linked tabs: add a tab there.
  3. A pane next to the thread's pane holds linked surfaces (any thread): add a tab there. Sides in
     order: right, left, below, above.
  4. Any pane in the space holds linked surfaces: add a tab there.
  5. There is room: a new pane to the right of the thread's pane (a split of that pane, not of its
     column), at the surface type's default size.
  6. Otherwise: a tab in the thread's own pane.
  In 3 and 4, a pane that already holds a linked tab of this thread wins, then the nearest. Threads and
  other surfaces may share a pane: a pane that also holds a thread tab counts like any other. A pane
  that is joined is never resized. "Room" means the conversation keeps at least 480px of width. Terminal tabs follow these
  same rules: there is no separate rule for terminals and no "below" default.
- **Where a thread's own tab opens** (a sidebar click, the CLI, a new thread): the focused pane,
  whatever it holds.
- **A surface that belongs to no thread** (a checkout's diff opened from Projects, a pull request
  opened from Pull Requests) opens as an unlinked tab in the pane of the page it was opened from.
- **Smart swap.** When a thread tab gains focus, every pane whose active tab is another thread's
  surface of the same type switches to this thread's, if that one is already open in that pane.
  Nothing is opened, moved or closed. On by default; a user setting.
- **Closing a thread** (its tab) closes the linked tabs in its space and remembers which were open and
  where. Opening it again restores them: into their old panes when the thread is back in the pane it
  was in, otherwise placed fresh beside it. Terminals closed this way keep running. No settings.
- **A thread whose tab is not open** can still have its surfaces opened from its sidebar menu
  (Open ▸ …); they go to the focused pane. For an open thread the same menu follows the placement
  rules. Plugins will add thread actions to this menu. A thread's own call for its surface while its
  tab is not open goes the same way, to the focused pane of the thread's space, behind the tab shown
  there, and the thread is told so; before any window has loaded the layout, the first load takes it
  into the thread's remembered set instead, and the thread is told that.
- **Moving a thread** to another space takes the linked tabs that are in its space. Archiving closes
  its linked tabs everywhere and ends its terminals. Snoozing closes them, ends its terminals and
  keeps the set, so the terminals come back as fresh shells in the same places; an open quick
  terminal comes back open, as a fresh shell, when the thread's tab opens.
- **The thread's header** in a pane holds the branch chip, the thread info toggle and one three-dot
  menu with submenus (Open, Move to space, rename, snooze, archive, close).
- **Thread info is per thread.** The toggle (and cmd+shift+i, for the focused tab's thread) shows or
  hides that thread's card only. The choice is kept with the thread in the daemon's layout, so it
  follows the thread across panes, spaces and restarts. A thread never toggled shows its card or
  not by a user setting (on by default). The card shows beside the conversation only when the pane is
  wide enough for it; in a narrower pane the toggle opens it as a temporary overlay instead, and
  showing the overlay turns that thread's card on for when the pane is wide again.

## Terminals

- **Quick terminal.** One per thread, inside the thread's pane under the conversation and composer.
  It pushes the content up while the composer and part of the conversation still fit, and overlays the
  bottom of the pane when they do not. Its header shows its directory; when that differs from the
  thread's, a quiet hint offers Reset, which starts a fresh shell in the thread's directory. It never
  resets by itself. The hint is right-aligned and the path shortens so Reset is always visible. Linked
  terminal tabs show the same hint in the row under the strip.
- **Terminal tabs** are named by what runs in them, with an icon; idle, by shell and folder. A manual
  name sticks until the automatic name is asked for again.
- **Closing a terminal's tab by itself ends the terminal**, linked or not. A terminal whose tab
  closed because its thread was closed keeps running, so reopening the thread brings it back.
- A terminal restored after a snooze shows its idle name and one line with the last command and
  "Run again". It never reruns by itself. The last command is the foreground job's command line as
  the process list gives it; there is no shell integration.

## Sidebar

- Sections, in order: **Needs you**, **Active**, then **Working**, **Snoozed** and **Archived** at
  the bottom as today. A click on a thread always adds a tab (or focuses it when it is open). Active
  keeps today's order (pinned, then the space's drafts, then threads woken from a snooze, then
  finished, then idle) and Pin stays in the row's menu.
- **A thread woken from a snooze** is not in Needs you: it goes to the top of Active (below the
  pinned threads and the drafts), most recently woken first, with its "Woke" status until the user
  opens it. It does not count in the Needs you number, a space tab's count or the top bar's
  control, and cmd+shift+a skips it.
- **Thread row.** Line 1: project on the left, status or time on the right; on hover the snooze and
  archive controls take that slot. Then the title at full width, up to two lines. Then the branch,
  with the pull request tag and the counts right-aligned. A thread with no project has no third line
  unless it has a tag or counts.
- **Needs you** lists the user's own threads that are blocked until the user acts: a permission
  prompt, a question from the model, a plan to approve. (It still also lists the other attention
  states it held before this rule, until they are decided: a folder trust dialog, a terminal
  notification or bell, an API error at the prompt, a plugin's attention flag and any other attention
  reason; see `shell-25a-test-feedback.md`.) Never threads started by threads; from every space, and such a thread is not also listed under Active. One toggle button switches
  between all spaces and this space; the choice is global. A row is the project and the kind of ask,
  then the same title. It has no buttons.
  - Hovering a row shows a card with the whole ask. A permission has Allow, Deny and "Go to thread".
    A question is never answered in the card: it offers the popup and the thread. The card can be
    entered with the pointer, grows with its content up to a maximum, and then scrolls.
  - Clicking the title opens the popup: recent messages, the ask with today's card (its own field for
    a deny reason), and "Go to thread". It dismisses the hover card until the row is hovered again.
  - With the sidebar collapsed, a control with the count appears in the top bar, to the right of back
    and forward, and opens the same list as a popover.
- **In a pane**, a thread that needs the user marks its tab icon with the attention dot, in a strip
  and in a rail. When the pane is too short for the full ask, the ask shows as a one-line strip above
  the composer with the same hover card and popup.

## Keys

| Key | Does |
| --- | --- |
| cmd+n | New thread |
| cmd+t | New terminal tab linked to the current thread |
| cmd+shift+t | New terminal tab linked to nothing, in the home directory |
| cmd+j | Quick terminal of the thread: open and focus, focus when open, close when focused. From a linked surface: go to its thread and open it |
| cmd+shift+j | Ring: the thread, each of its terminal tabs, the thread. From a view it starts at the first terminal |
| cmd+shift+d | The thread's diff; again from the diff, back to the thread |
| cmd+shift+i | Thread info of the focused tab's thread (per thread) |
| cmd+p | Find a file; it opens as a tab |
| cmd+k | Palette, which opens every surface |
| cmd+w | Close the focused tab (a thread is closed from the space, never archived); focus returns to what had it before |
| cmd+shift+w | Close the focused pane |
| cmd+[ / cmd+] | Back and forward through what was focused, across panes and spaces |
| cmd+shift+[ / cmd+shift+] | Previous and next tab in the pane |
| ctrl+cmd+h j k l, ctrl+cmd+arrows | Focus the pane to the left, below, above, right; with shift, move the pane |
| ctrl+cmd+1…9 | Switch to that space |
| cmd+1…9 | Jump to that thread of the list, as today |
| cmd+shift+enter | Full screen the pane; escape leaves |
| cmd+shift+a | The popup of the next thread that needs the user |
| cmd+r | Rename the focused tab, where it can be renamed |
| cmd+shift+r | Automatic name: a thread's is generated again, a terminal goes back to its automatic name |
| cmd+b | Sidebar |

The direction keys go to a pane that touches that side of the focused pane, as drawn (rails
included). Of several, the one focused most recently wins (the pane the last direction key left
counts as such, so a key and its opposite come back), then the one sharing the longest stretch of
edge, then the upper (left and right) or the left (up and down). A direction key pressed while a
pane move is on its way to the daemon waits for it to land.

Retired: cmd+shift+e (side panel), cmd+\ and cmd+alt+\ (panel split and its other group), the
bindings for Show Pull Requests and Show Projects (the palette and "+" open them), and the old
meaning of cmd+shift+[ and ] (previous and next thread).

## State

The space the user is in is remembered: the app reopens in it, with its layout as it was.

Spaces, pane trees, tabs and each thread's remembered set live in the daemon, so the CLI and a
thread's model can read and change a layout. Every user action is a command. The model-facing verbs
are named `view.open.*`; today's `view.panel.<item>` verbs stay as unlisted aliases for one stable
release.

## First load for an existing user

One empty space, showing the composer. No thread is opened for the user. Every thread stays in the
sidebar with its old side panel tabs and terminals stored as its remembered set, so they come back
when the thread is opened. A terminal that is still running when the import runs keeps running: a
thread's first bottom terminal becomes its quick terminal and the others become linked terminal
tabs. An update restarts the daemon, which ends its terminals, as it always has; a terminal that no
longer exists is not carried over, and no fresh shell is started in its place.

## Not in this change

Thread colours, drawers inside a thread pane, panes that follow focus, replacing a tab on a sidebar
click, a file browser surface, content search across files, and the surface contract for plugins
beyond the identity rule above.

## Build

The build is summed up in `docs/notes/shell-build.md`: the step notes in order, where the build
departs from its plan, and what is not in this change. The plan itself (`shell-plan.md`) was
removed before the merge to `main` and is in git history. The interactive toy the plan mentioned
was a reference for algorithms only; where it differed from this file (it placed terminals below
and by family), this file won.

Composer drafts and remembering the current space were added to this file after PRs 1 and 2
were briefed: a small layout PR after PR 2 gave drafts their identity, and the sidebar PR lists
them.

Answers to the plan's open questions that differ from its recommendations: placement may join a pane
that holds a thread tab (question 5); a thread's tab opens in the focused pane (question 2); closing
a terminal's tab ends it (question 6); there is no "thread last viewed" and no change on `main` for
it, the first space starts empty (question 3).
