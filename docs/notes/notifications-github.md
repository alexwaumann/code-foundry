# GitHub notifications

The daemon posts to the bell from the GitHub data the gh store already polls, and withdraws each
card as soon as its condition is known to be gone. Built on the notification store
(`notifications-1-store.md`) and the PRs inbox's dashboard (`prs-inbox-1-daemon.md`,
`prs-inbox-2-gui.md`). No new request to GitHub, no migration, no new command.

## What landed

| File | Holds |
| --- | --- |
| `internal/daemon/github_notifications_rules.go` | the pure rules: dashboard + viewer + linked threads + projects → the cards to post, and `ghPlan.Withdraw(key)` for every other active card |
| `internal/daemon/github_notifications.go` | the glue: gathers the input from the stores, evaluates on events, reconciles the notification store |
| `internal/daemon/plugin_notifications.go` | `github` in `hostSources`: no plugin may be named so, and the plugin sweep never takes its cards |
| `internal/store/gh` | `Dashboard.ReviewedListed`: how many the reviewed search returned before the requested ones were dropped |
| `gui/frontend/src/lib/notifications.ts` | `sourceLabel` shows "GitHub" for source `github` (a small registry of the app's own sources) |
| `gui/frontend/mock/notifications.ts` | `POST /__mock/notifications/github`: the four cards as the daemon words them |

## The four cards

Source `github`. Key `pr/<owner>/<name>#<number>/<kind>` (the repository lower case), so a change
updates the card in place. One card per pull request and kind.

| Kind (key suffix) | Posts when | Level | Time-sensitive |
| --- | --- | --- | --- |
| Review requested (`review-requested`) | the PR is in the viewer's review-requested list, open, not a draft | info | yes |
| Review again (`review-again`) | the PR is in the reviewed list and not the requested one, open, not a draft, and the viewer's latest review is not on the head (an empty commit counts) or was dismissed | info | yes |
| Changes requested on your PR (`changes-requested`) | the PR is in the authored list, open, and another reviewer's latest review is CHANGES_REQUESTED on the head commit | warning | no |
| Merge conflict on your PR (`conflict`) | the PR is in the authored list, open, and `mergeable` is CONFLICTING | warning | no |

"Review requested" and "Review again" are the inbox's rule (`reviewQueue.ts`) in Go
(`reviewAgain`): requested wins over reviewed; no review of the viewer's reads as "commented",
not stale; an unknown head never makes a review stale. The rule lived only in the frontend; it is
duplicated in Go, and the tables in `github_notifications_rules_test.go` pin the inbox's cases.
A PR is in exactly one of the two at a time: the one not posted is withdrawn.

Changes requested needs the review on the head commit: a push moves the head past it, an approval
or a dismissal replaces the reviewer's latest review. The viewer's own reviews never count.

## When a card goes (only positive knowledge withdraws)

A card that the evaluation does not post is withdrawn only when its condition is known to be gone:

- the PR is in recently merged, or any list has it in a state other than open (the fingerprint's
  state is live; GitHub's search index trails a merge);
- review requested: the PR is now in the reviewed or authored list, or it is a draft now, or it is
  missing from a **whole** requested list;
- review again: the PR is in the requested list (the other kind takes over), or the viewer
  reviewed the head (a known detail), or it is missing from a **whole** reviewed list;
- changes requested / conflict: a known detail says so (`mergeable` MERGEABLE for the conflict),
  or the PR is missing from a **whole** authored list;
- the source is off (below), or the key is not one this version posts.

Kept as they are (neither posted nor withdrawn):

- **Placeholders** (`Partial`: the fingerprint only, the detail fetch pending or failed).
- **Mergeable UNKNOWN** (or empty) for the conflict card.
- **Reviews without commits** (`ReviewCommits` false: a cache from before PR 1's heal) for review
  again and changes requested; the next poll heals it. The inbox counts such a review as stale for
  that one poll; the bell does not post on it, to avoid a burst of wrong cards on an upgrade.
- **A list cut at its page size.** A list is whole when it holds everything its search matched:
  `len(list) >= total` for requested and authored, `ReviewedListed >= ReviewedTotal` for reviewed
  (its list has the requested ones removed, so its own length cannot say). A cache written before
  `ReviewedListed` existed reads 0, i.e. not whole, until the next poll.
- **A failed poll.** The gh store keeps each section's last good list when its search fails, and
  the whole dashboard on a failed poll, so the evaluation sees what it saw before: nothing new.
- **Signed out.** The store's lists are the last known but nothing is current: the input has no
  viewer, so nothing is posted or withdrawn until it signs in again.

## Turned off, signed out, never polled

- `github.dashboards_enabled` off (read from the settings at once, and the poll's
  `Dashboard.Disabled`): every card is withdrawn and none posted. The user turned the source off.
- Signed out: frozen (above). Signing out of `gh` is not turning the app's GitHub off, and may be
  passing (a locked keychain).
- Never polled (no viewer, `Dashboard.FetchedAt` zero): nothing.

## Content and dismissal

Content is what the store hashes (title, body, level, time-sensitive, thread, actions). A
dismissed card comes back only when its content changes, so the content is chosen per kind:

- **Review again** carries the head commit in its "Review in a thread" prompt: each push is new
  content, so a dismissed card comes back with the next push (`TestGitHubNotificationsDismissal`).
- **Review requested** carries nothing that moves with pushes or comments: a dismissed card stays
  gone while the request stands. A new title or author, or the request changing from a team to
  the viewer by name, is new content and brings it back.
- **Changes requested** carries the head commit in its thread action: a new round of changes
  requested after a push comes back. Who requested is in the body.
- **Merge conflict** carries the head commit, not the base: a push that does not fix it, or a
  new conflict after a fix (which takes a push), comes back; the base moving does not.
- Comment counts are left out of every card (the sketch had "3 comments"): each comment would be
  new content and bring a dismissed card back.

## Buttons

Up to two, "Open PR" first (the primary):

- **Open PR**: an `open` action with the PR's URL (the browser). The in-app PR tab
  (`view.open.pr`) needs a thread to open in and the PRs page's side panel is GUI state, not a
  command; a notification action cannot name either, so it opens GitHub as a toast's buttons do.
- **Review in a thread** (both review kinds): a `start` action, read-only review prompt ("do not
  submit a review or post comments on GitHub"), in the project whose origin is the repository
  (the first registered), else no project.
- **Send to thread** (changes requested, conflict) when a thread links the PR: the card names the
  thread (row mark, thread link) and the action sends it a short instruction. The thread: not
  archived, its own link (Claude's, a branch's, by hand) before a copy from a thread it created,
  then the newest link. With none, **Fix in a thread**: a `start` action in the tracking project.

The buttons only open a link, start a thread or message one; the agent does the work.

## When it evaluates

At start and after every `gh.DashboardUpdated`, `gh.ViewerUpdated`, thread event, project event
and `settings.Changed`, debounced 300 ms. The first evaluation waits for the projects' first
reconcile after a start (every git project has a default branch or an error; at most a minute):
until then their GitHub slugs are empty, a start action's project would flip and a dismissed card
would come back. The first evaluation reconciles: it posts what holds and withdraws the source's
cards whose condition is gone, including cards for PRs no longer in any whole list.

ErrFull (100 active per source): the posts past it are refused; one warning per run of full
evaluations, not one per post.

## Differences from the brief and the sketch

- **Drafts**: the brief says no review cards for drafts, and to match the inbox. The inbox
  (`reviewQueue.ts`) does not filter drafts: a requested draft is in "Needs your review". The bell
  follows the brief's rule; this is the one case where the bell and the inbox differ. Making the
  inbox drop drafts too is a one-line change in `reviewQueue` if wanted.
- **"Review again: 2 new commits"**: the poll does not fetch commit counts (a count since the
  review needs a compare per PR), so the title is "Review again" always.
- **"3 comments"** is left out of the changes-requested body (dismissal, above).
- **Review requested body**: "by <author>, requested from you" when the requests name the viewer,
  "requested from your team" when they name others (a team), "your review is requested" when they
  are not known.

## Tests

- `github_notifications_rules_test.go`: every post rule and every withdraw path (table), keys,
  card text and buttons, linked threads, content across pushes.
- `github_notifications_test.go`: the glue over `ghtest` and the real store (`notificationtest`):
  post → update in place → withdraw for each kind; dismissal; a failed poll, cut lists,
  placeholders, unknown mergeable and signed out keep cards; merged withdraws; the start
  reconcile; off; a linked thread and its archive; ErrFull logged once; the loop waiting for the
  projects then evaluating on events. `TestPickLinkedThreads`, `TestProjectsSettled`.
- `plugin_notifications_test.go`: a plugin named `github` is refused; `github` is not a plugin
  source. `poll_test.go`: `ReviewedListed` counts the requested ones.
- vitest `lib/notifications.test.ts`: the label.

## End to end (2026-11-17, `make drive DAEMON=dev`, scratch home under /tmp)

- The owner's account: five authored PRs on scratch repositories, all mergeable, no reviews, no
  requests: the bell stayed empty, as it should.
- `CODE_FOUNDRY_GH_SEARCH_AS=mitchellh` (a busy public account; read only, nothing changed on
  GitHub): the first poll posted 50 "Review requested" (the whole requested list, no drafts) and
  one "Merge conflict" (ghostty-org/ghostty #12938, the one conflicting authored PR), agreeing
  with `GetDashboard`. The GUI's bell showed them with "GitHub", Open PR and Review in a thread.
  A dismissed card stayed dismissed across the next poll. Setting `dashboards_enabled = false`
  in the scratch settings file withdrew all 50 within a second (the dismissed one stayed
  dismissed); setting it back brought them back after the next poll, the dismissed one still
  dismissed. With the search override the viewer is still the token's account, so no review is
  "the viewer's": no review-again cards, and team wording on requests that name other people
  (the inbox shows the same, `prs-inbox-2-gui.md`).

## Gotchas

- `notification.Snapshot` holds active cards only; a dismissed card is never touched by the
  reconcile, so its content decides whether it comes back (above).
- A known PR whose detail fetch failed keeps its old detail with the fingerprint's head
  (`resolveFingerprints`): for one poll, a review on the new head may look stale. The next poll
  fixes it.
- A source's notifications are posted by the daemon, never by a plugin: a future host source goes
  in `hostSources` too.
