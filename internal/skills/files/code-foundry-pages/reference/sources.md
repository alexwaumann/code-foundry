# Live data: what cf.on sends

{{cf.provenance}}

For the code-foundry-pages skill: the value `cf.on(source, fn)` passes to `fn`, per source.
It is the app's own view model, the one its windows draw from:

- enum values are lower case (idle, merged, running), never THREAD_STATUS_IDLE;
- times are epoch milliseconds in fields ending in AtMs (null when unknown): render them
  with `new Date(ms)`; a field without AtMs is not a time unless this file says so;
- every field listed is present, with "", 0, false, [] or null when empty.

`cf.run(verb, args)` resolves `{text, json}` where `json` is what `code-foundry <verb>
--json` prints: the CLI's shape, with enum names in capitals (THREAD_STATUS_IDLE), ISO
time strings without AtMs, and false, 0 and "" fields left out. The same thread or run
has other field names there. Read a `cf.run` result with the names you saw from `--json`
in Bash, and a `cf.on` value with the names below; never one with the other's.

The fn gets the whole value at once (when there is one) and again after every change.
The third argument, `onError(e)`, gets a refusal (unavailable: the app does not hold the
source now; a misspelt source throws at the call): show `e.message` in the page, or the
user sees a board that never fills. `cf.off(source)`, or the function `cf.on` returns,
ends the subscription.

## Lists with buttons that update live

A change re-draws the list while the user's pointer is on it: a row that moves under the
pointer makes a click act on the wrong one. So:

- keep rows where they are between updates: sort by a stable key (`id`, a creation time),
  or keep the order the rows had and add new ones at the end;
- re-sort (by status, by time) only on a Refresh click, or while nothing in the list is
  hovered or focused (`list.matches(":hover")`, `list.contains(document.activeElement)`);
- each button's handler acts on the id its row was drawn with (`const id = t.id` in the
  closure), never on an index into the latest array;
- an archived or snoozed thread leaves the list at once (filter on `archivedAtMs`,
  `snoozedUntilMs`); after your own Archive click remove the row from the result, not
  from the next update.

## Page storage, in detail

`get(key)` and `keys()` answer at once from the copy the page got with `cf.ready`; `set`,
`remove` and `clear` change that copy at once and return a Promise that rejects when the
thread's storage is full (256 KiB, 1 KiB a key) or the write was refused: the value is
then put back. Another page of the thread writing a key updates this page's copy.

## Tokens for an external API

The frame cannot sign in: SSO and OAuth redirects fail, and it has none of the user's
browser cookies. For an external API (Linear, Jira, Sentry) ask the user to paste an API
token into a password field, keep it in `cf.storage`, and send it in `fetch` headers;
never write it into the file. The API must allow cross-origin calls (GitHub's and
Linear's do); if it does not, say a plugin is needed. A `fetch` is not a Code Foundry
verb: it needs no click.

## thread-list

An array of the user's threads in sidebar order (threads a plugin owns left out). Each:

- `id`, `name`, `projectId`, `worktreePath`, `workspaceId`, `model`, `effort`: strings.
- `status`: busy, idle, attention, error or unknown. `statusReason` says why in one line
  (finished, at prompt, "permission: Bash git push", interrupted, crashed);
  `statusChangedAtMs`.
- `pinned`; `archivedAtMs` and `snoozedUntilMs`: null unless the thread is archived or
  snoozed (filter those out of a board).
- `createdAtMs`, `lastActivityAtMs`.
- `parentId`, `createdBy`, `createdByName`: the thread that started it ("" for the user's
  own); `inSidebar`: null (the setting decides; children are hidden by default), true or
  false; `labels`: strings.
- `costUsd`: USD so far; `unpriced` true means a lower bound (say so, never $0).
  `usage`: buckets of `model`, `day` (UTC YYYY-MM-DD), `requests`, `input`, `output`,
  `cacheRead`, `costUsd`.
- `contextTokens`, `agentsRunning`, `backgroundShellsRunning`: numbers.
- `report`: null, or the thread's last report: `status` (done, blocked, failed,
  progress), `summary`, `atMs`.
- `linkedPullRequests`: `slug`, `number`, `url`.

## thread

`{thread, pending}`: `thread` is the page's own thread as in thread-list (null before the
app knows it); `pending` the requests it waits on: `requestId`, `question` (true for a
question, false for a permission), `toolName`, `summary` (one line). No conversation items.

## gh

Nothing until the app's first read of GitHub (fn is not called). Then the pull requests of
the user's projects:

- `authenticated`: false when gh is signed out (say "gh auth login"); `viewer`: null or
  `login`, `name`, `url`.
- `authored`: the user's open PRs; `reviewRequested`: open PRs waiting for the user's
  review; `reviewed`: open PRs the user reviewed; `recentlyMerged`: merged in the last 7
  days. No closed PRs, and no PR outside these lists.
- `dashboardsDisabled`: the lists are off in Settings; `fetchedAtMs`; `lastError`;
  `trackedSlugs`: the repositories (owner/name) the lists cover.
- Each PR: `repoSlug`, `number`, `title`, `url`, `author`, `state` (open, closed, merged),
  `draft`, `headRef`, `headSha` (pr.merge's head-sha), `baseRef`, `review` (approved,
  changes_requested, review_required or null), `checks`: `state` (none, pending, success,
  failure, error, expected), `total`, `passed`, `failed`, `pending`, `skipped`;
  `mergeable` (mergeable, conflicting, unknown or null), `mergeState` (clean, blocked,
  behind, dirty, unstable…; "" when unknown), `createdAtMs`, `updatedAtMs`,
  `mergedAtMs`, `additions`, `deletions`, `changedFiles`, `comments`, `reviewRequests`
  (logins and org/team),
  `partial` (true: only the number is known yet, the title comes later).
- Green: `checks.state` success, `draft` false, `mergeable` not conflicting.
- A merge from the app moves the PR to `recentlyMerged` at once; still update the row from
  the merge's own result.

## action

`{actions, runs}`.

- `actions`: `id`, `projectId`, `name`, `command`, `icon`, `inTerminal`,
  `onWorktreeCreate`, `position`.
- `runs`: `id`, `actionId`, `actionName`, `command`, `projectId`, `threadId`,
  `worktreePath`, `mode` (terminal or background), `terminalId`, `running` (true while it
  runs; there is no state field), `exitCode` (once not running; 128+n for signal n),
  `startedAtMs`, `finishedAtMs` (null while running), `trigger` (user or
  worktree-create).

## plugin

An array of installed plugins: `name`, `displayName`, `version`, `description`, `state`
(disabled, starting, running, crashed, stopping, stopped, failed), `enabled`,
`lastError`, `needsConsent`, `updateAvailable`, `updateVersion`, `startedAtMs`,
`commands` (each `name`, `title`, `description`) and `surfaces` (each `id`, `title`,
`icon`, `scope`: global, thread, project, worktree or pr).

## terminal

An array of terminals: `id`, `title`, `argv`, `cwd`, `state` (running or exited),
`exitCode`, `startedAtMs`, `exitedAtMs`, `labels` (an object of strings).

## project

An array of projects: `id`, `name`, `path`, `githubSlug` (owner/name or ""),
`defaultBranch`, `remotes`, `git` (false: a plain folder, no branch to show) and
`worktrees`, each `path`, `branch`, `head`, `detached`, `isMain` and `status`: `ahead`,
`behind`, `staged`, `modified`, `untracked`, `conflicted`, `dirty`, `baseRef`,
`baseAhead`, `baseBehind`.

## workspace

An array of workspaces: `id`, `name`, `branch`, `members` (each `projectId`,
`worktreePath`), `createdAtMs`.

## settings

`values`: every setting's key (appearance.font_size) to its value as a string ("14",
"true"); `revision`; `loadError`; `issues` (each `key`, `message`); `restartPending`:
keys waiting for a restart. The settings.set verb changes one.

## update

`state` (idle, available, downloading, downloaded, installed, restartRequired, failed),
`currentVersion`, `latestVersion`, `targetVersion`, `channel` (stable or tip), `enabled`,
`checking`, `lastCheckError`, `notesUrl`, `progress`, `failureReason`, and
`lastCheckedAt`: the one time here that is an ISO string (or null), not milliseconds.

## ember

Ember's board, only while the app holds it: Ember's sidebar row, chat or Board panel is
open. Otherwise the subscription is refused: the third argument of `cf.on("ember", fn,
onError)` gets an error with code unavailable and a message saying so. Show that message
to the user (with a Retry button that subscribes again); never show an empty board as
"no tasks". The board:

- `status`: `enabled`, `threadId`, `epoch`, `consolidating`, `counts` (`todo`, `doing`,
  `blocked`, `done`, `cancelled`).
- `tasks` in board order: `id`, `title`, `detail`, `state` (todo, doing, blocked, done,
  cancelled), `parentId`, `threadId`, `outcome`, `branch`, `position`, `createdAtMs`,
  `updatedAtMs`, `doneAtMs`, and `thread`: null, or its worker's `name`, `status`,
  `statusReason`, `reportStatus`, `reportSummary`, `archived`, `removed`.
- `timers`, soonest first: `id`, `nextAtMs`, `every` ("1h", "" for once), `note`.

## ui

A feed: app notices as they happen, nothing at first. Each has a `kind` and its fields:
notify (`level` info, warning or error; `title`, `body`), focusThread (`threadId`),
showView (`name`, `threadId`, `params`), focusTerminal (`terminalId`), focusProject
(`projectId`, `worktreePath`), openPalette (`query`), playAlertSound (`volume`),
showAgentRun (`threadId`, `runId`).
