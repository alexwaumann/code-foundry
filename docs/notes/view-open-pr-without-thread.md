# view.open.pr without a thread

A user: "We should be able to open any PR that's for a project we track. It shouldn't be a
requirement for a PR to be linked to be able to be opened." `view.open.pr` needed a thread (its
`When` was `hasThread`, and the repository came from the thread's links, else its project), so a
command could not open a pull request's tab that the Pull Requests page's rows open with a click.
The GitHub notifications' Open PR (`notifications-github.md`) had to send the user to the browser
for that reason; it now runs this command.

## What changed

- `view.open.pr` takes `--repo-slug owner/name` (the arg name every `pr.*` command and the GUI's
  `prArgs` use; not `--repo`). Its `When` is gone: any caller; `Run` refuses what is missing.
- **No thread, `--repo-slug`**: the gh store must read `owner/name#N` (`GetPullRequest`, the same
  check and wording as before: "no pull request #N in owner/name"), then the tab opens through
  `open_surface` with no thread and no space: the current space, the focused pane (rule
  `focused`), exactly the op the page's row sends (`hostShell.ts shellOpenTab` with a non-thread
  target). Params `slug` (as given, or as the store spells it) and `number`, title `#N`.
- **A thread, `--repo-slug`**: names the repository directly, neither the links nor the project
  asked. This also answers the old "links #N in 2 repositories" refusal, which now says to pass it.
- **A thread, no `--repo-slug`**: as before.
- **No thread, no `--repo-slug`**: an ArgError on `thread` naming both ways.
- Focus: `wantsFocus`, as every view.open verb. A caller with no thread is the user's (the app,
  the CLI outside a thread), so it focuses unless `--focus=false`. From inside a thread the
  thread arg is filled from `$CODE_FOUNDRY_THREAD`, so that path is the thread's (no focus
  without `--focus`).
- The CLI's message for a tab of no thread: `opened tab t-… (of no thread) in pane p-… of space
  sp-…`; an open one: `tab t-… (of no thread) is already open in pane …`.

## One tab

The layout's identity for a pull request is `pr:<owner/name lower case>#N`, scope space, and it
ignores the tab's thread (`internal/layout/identity.go`). So the page's tab, the command's and a
thread's for the same pull request in a space are one tab: an open one is used where it is (and
focused when asked), whichever opened it and however the slug is cased. The GUI's seam id
(`pullRequestTabId`) is the same rule on the window's side; the layout's tab ids are its own
(`t-…`), so "same tab" is tested as the identity key and the second call's `existing`.

## Which repositories

Any pull request the gh store can read, as the Pull Requests page already opens pull requests of
repositories no project tracks. Limiting to tracked projects would refuse what the page shows;
found no reason to.

## Current space from the CLI

The same as `view.pullrequests` and `view.projects`: `open_surface` with no space is the layout's
`CurrentSpace` (the one the user last switched to in the app). With no window open, the tab waits
in the layout for the next window.

## The bell

`notification.SourceGitHub` ("github") joins `verbSources`: its command actions name a registry
verb. Open PR is `view.open.pr` with `repo-slug`, `number` and `focus: "true"` (pressing a button
means "show me", whatever the caller), `Resolves` false. `notification.act` runs it with the
caller's view and origin, no thread, so it takes the no-thread path from the bell and from
`code-foundry notification act <id>` alike.

The mock mirrors it: `mock/panelItemVerbs.ts` (the no-thread path, checking only the slug's
shape), and `mock/notifications.ts` runs command actions of source `github` through the mock's
registry (the plugins source's stay recorded only: the mock's `view.settings` has no `--page`).
The mock's GitHub cards now name pull requests its dashboard holds, so the tab shows one.

## Tests

- Go: `commands_view_open_pr_test.go` (no thread from the CLI and the app, `--focus=false`,
  `--pane`, refusals open nothing, one tab after the page's row / a thread's / itself, the act
  from the bell, the CLI and a thread's CLI, an unreadable PR failing the act);
  `TestPanelPR` (thread + `--repo-slug`); `TestNotificationAct` (the `github` mapping);
  `TestGitHubNotificationCards` (the action).
- vitest: `mock/panelItemVerbs.test.ts`, `mock/world.test.ts` (the mock card opens one tab).
- e2e: `notifications.spec.ts`, one test: pressing Open PR shows the PR surface, its tab focused
  across the layout stream; pressed again after moving away, the same tab focused.
