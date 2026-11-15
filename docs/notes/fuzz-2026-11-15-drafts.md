# Fuzz pass 2026-11-15: composer drafts

Three findings from the 2026-11-15 fuzz pass (since v0.21.7), all about composer text a user
loses.

## 1. Text typed into an archived thread's composer vanished

**Found.** A user opens an archived thread (a preview from the Archived section) and types a
follow-up. Sending to an archived thread is supported: it unarchives it. As soon as any other
thread changed, the composer emptied while it still had focus.

**Cause.** `startComposerDrafts`' `pruneThreads` (`shell/composerDrafts.ts`) runs on every
threads-store change and cleared `thread:<id>` for every thread whose `archivedAtMs` was set: a
state check, so an archived thread could never hold text.

**Fix.** It clears on the change into archived: the previous `byId` is kept, and a thread's text
goes when that thread was not archived before and is now, or when it leaves the list. Text
already there when the list first loads stays. Before, text typed into an archived thread was
lost on a reload; now it is kept until it is sent, which unarchives the thread. Archiving a
thread still drops its unsent text, as the spec says.

## 2. A heading pick on a draft opened a blank tab, or reverted after a restart

**Found.** In a compose tab, picking another project, a workspace or No project in the heading
("What should we build in **alpha**?"):
- to or from No project opened a new, blank New thread tab with the focus, and the draft stayed
  in its old tab;
- to another project or a workspace changed only the heading. The tab's params and the draft's
  sidebar row kept the old project, and after a restart the draft (and a send) went back to it.

**Cause.** The No project moves went through `switchDraftTarget` → `retargetShellDraft` →
`showComposer` → `select()`. The selection bridge saw a compose selection the focused tab's
params did not match, and ran `composer.new`. Project and workspace picks went through
`writeSet`, which changes only the compose store's in-memory set. Nothing wrote the tab's params.

**Fix.** `ProjectSwitcher` gets the compose tab's id (from `Composer`'s `tabId`). In a tab, a
pick of a different target calls `retargetComposeTab` (`stores/compose.ts`). It rewrites the
draft's text for the new target's projects, behind the same confirm when tags of projects that
leave would go. Then it writes the tab's params with `set_tab_params`. The daemon keeps the
`draft` param and the draft's list entry takes the new params (an existing op and golden test),
so the row, a reload and the send all read the new target. An empty compose tab only takes the
params. A pick of the tab's own project still narrows the set in place (`setDraftProject`).
Outside a compose tab (the empty space's composer) the classic `switchDraftTarget` path is
unchanged. `retargetShellDraft` had no other caller and is gone.

`ComposeTab` now keys its `Composer` by the tab, not the target. Keyed by the target, the new
params remounted the editor and the caret went back to the start of the draft, so the next key
landed there. Keyed by the tab, the editor stays, as it already did when a draft's id arrived
on the first keystroke.

**Left out.** Projects added with the chip row's "Add project" are still kept only in memory.
The tab's params name one project or workspace, so storing a multi-project set would need a new
param. That is a different change.

## 3. Text typed in a space with no pane was not a draft

**Found.** A space with no pane (a fresh home, a new space, the last tab closed) shows the No
project composer (`EmptySpace`). Its text lived only in memory under the shared `home:` key. It
had no sidebar row, every empty space showed the same text, and a restart lost it. A heading pick
moved it into a compose tab that did not become a draft either.

**What the spec asks, and what was done instead.** shell-model.md: "Once something is typed, the
composer is a draft", and a draft is a tab. Doing that means opening a compose tab in place of
the empty space on the first keystroke. Every open pane draws a tab strip, so the composer, which
is centred, would shift down mid-word. It would also remount the editor: the caret goes back to
the start (ProseMirror's initial selection), and an IME composition in progress breaks. So the
smaller change was taken instead:

- **The text is the space's own.** The No project composer's text (`home:`) is the text of the
  space the window shows, whether or not that space has panes. `followSpace`
  (`shell/composerDrafts.ts`, on every layout change) moves it to `space:<id>` (`SPACE_KEY`,
  lib/compose) only when the window shows another space, and moves that space's own back. Two
  spaces never share it. A pane opening in the space (a thread clicked in the sidebar, cmd+n)
  does not hide it: a No project compose tab there shows it, and a key typed there makes it a
  listed draft, as any text typed in that tab does, with no copy left under `home:` or `space:`.
  A send on its way is left where it is. A removed space's text goes with it.
  - A first version moved the text out as soon as the space got a pane. Text typed in an empty
    space and then followed by opening a thread there was parked where no composer showed it
    until the space was empty again. Review caught it before merge.
- **It survives a restart.** The stored document gains `spaces: { [spaceId]: text }`, written
  and restored like the drafts' text. The live `home:` text is stored under the space showing it.
- **Moved into a compose tab, it becomes a draft.** `ComposeTab`, showing its empty composer
  with text already under its target's key, calls `composerTextChanged` as if it were typed. A
  heading pick in the empty space moves the text there. No project is left out of this, because
  its welcome prefill is not the user's text.
- **Welcome.** `startWelcomeSync` clears an untouched welcome prompt from `space:` keys as well
  as `home:` when the first project arrives. Otherwise the prompt, kept for a space while a pane
  (Add project's Projects tab) covered it, would return after the welcome had ended.

The empty space's text still has no sidebar row: it is not a listed draft.

## Verified

- vitest: `shell/composerDrafts.test.ts` (archived on the change, typing into an archived thread
  survives other threads changing, the empty space's text per space, across a reload, with its
  space, while sending), `stores/compose.test.ts` (`retargetComposeTab`: params per target, empty
  tab, confirm cancelled), `components/compose/ProjectSwitcher.test.tsx` (which call a pick makes,
  in a tab and outside), `components/shell/ComposeTab.test.tsx`.
- Dev daemon (`make drive DAEMON=dev`, scratch home and repos):
  - text typed into an archived thread's preview stayed through two renames of another thread;
  - a draft on alpha → beta → alpha → No project: one tab throughout, and the row and the tab's
    params followed each pick;
  - text typed after a pick went where the caret was;
  - after a reload, the draft was on No project with its text;
  - text typed in Main's empty space was not shown in a new space Two, came back in Main, and
    stayed through a reload;
  - text typed in an empty space, then a thread opened there from the sidebar, then New thread ›
    No project: the composer showed the text, and one more key made it a listed draft, once;
    space Two's No project composer stayed empty, and a reload kept both as left;
  - typing in Two's empty space and picking alpha gave a listed draft on alpha;
  - a full daemon restart on the same home kept both drafts' params (Main's on No project, Two's
    on alpha, its row reading alpha);
  - typed in an empty space and sent at once with cmd+enter: the thread opened, and closing its
    tab left the space's composer empty.
  - The drive's browser profile is in memory and the Vite origin changes, so stored text can only
    be checked across a reload, not across a drive restart.
- e2e: composer-switch, compose, home, project-sets, shell-keys-drafts, shell-sidebar,
  welcome-composer, shell-preview-tabs and composer-fixes pass. These cover the compose tab's
  composer, which is now keyed by the tab.

## Gotchas

- In the full parallel vitest run, `ComposerProjectSet.test.tsx` hit its 5 s timeouts under load
  from other worktrees. The file passes on its own.
- A heading pick in the empty space opens a new compose tab (a remount), so the caret is at the
  start of the moved text. It was already so before this change.
