---
name: code-foundry-pages
description: "Build an HTML page that reads Code Foundry live and acts on it through /cf/bridge.js: a dashboard, board, tracker, form, chart, checklist or tool in the conversation (merge PRs, archive or start threads, change a setting). Use when the user wants a page, dashboard, form, chart, tool, checklist, board or tracker, asks to see something as UI, or a page of yours misbehaves."
---

# Pages that use Code Foundry

{{cf.provenance}}

A page is one `.html` file you write in `$CODE_FOUNDRY_PAGES` and show with
`code-foundry view.inline <path>`: interactive, in this conversation, in the user's theme.
With `/cf/bridge.js` it reads the app live and runs the commands you run with the CLI, as
this thread. Complete examples: `reference/examples.md` beside this file.

## Page, plugin or reply

- **A page** when the user wants something to look at or click: a list with buttons, a
  board, a form, a live chart, a slider. It runs only while it is on screen.
- **A plugin** (the code-foundry-plugin skill) when it must work with no page open: in the
  background, on a schedule, on every new PR, or as a side panel tab of its own.
- **A plain reply** when one answer is enough ("which PRs are green?").

## Before you write it

1. Find the verbs ("Verbs pages use" below, or `code-foundry daemon.capabilities --group
   commands`); `code-foundry help <verb>` for each one's args.
2. Run each read with `--json` in Bash: the page gets that JSON as `json`. Use only fields
   you saw there or in "Live data" below; never guess names.
3. One file, no build step, no framework, no CDN: plain DOM, `<script type="module">`
   (top-level `await` works), inline CSS. Paint only with `--cf-*` variables and the
   type-role classes (the code-foundry skill names them), never fixed colours.

## The skeleton

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<script src="/cf/bridge.js"></script>
<body class="text-body">
<div id="out">Loading…</div>
<script type="module">
  await cf.ready;                       // cf.thread, cf.theme and cf.readOnly are set now
  const out = document.getElementById("out");
  cf.on("thread-list", (threads) => { out.textContent = threads.length + " threads"; });
</script>
```

The bridge follows theme switches and sizes the card: no `cf:theme` or `cf:resize` code.

## The bridge

```
{{cf.bridgeAPI}}
```

- `cf.run(verb, args)`: the dotted verb (`pr.merge`) and its flags by name, without the
  dashes, positional ones too: `cf.run("pr.merge", {"repo-slug": pr.repoSlug, number:
  pr.number, method: "squash", "head-sha": pr.headSha})`. Values are strings, numbers or
  booleans. Never pass `yes`. It resolves `{text, json}`: `json` is what `--json` prints.
- **Reads run any time** (on load, from `cf.on`): `cf.readOnly` lists them (thread.get,
  thread.list, usage.show, pr.checks, settings.get…).
- **Every other verb runs only from a click or key press in the page.** Call `cf.run`
  inside the button's `click` (or a form's `submit`) handler, before any `await`; never on
  load, from a timer or from `cf.on`. For several, start them all in the handler:
  `await Promise.all(items.map((x) => cf.run(…)))`, not one `await` after another (the
  gesture expires). A slider acts on `change`, not `input`.
- **The app asks the user** before a verb that needs it (merging a PR, archiving a busy
  thread): its own dialog opens over the page. Add no `confirm()` of your own for those.
- **This thread**: verbs whose `id` defaults to your thread refuse to archive, remove or
  snooze it without one. Pass `id: cf.thread.id` when the page acts on its own thread,
  the other thread's id otherwise. Leave `cf.thread.id` out of lists of threads to act on:
  archiving the page's own thread closes the page.
- **Threads a page starts** (`thread.new`) are this thread's children, hidden from the
  sidebar: pass `sidebar: true` when the user will want to see them, and a `prompt`.
- **Errors**: `cf.run` rejects with an `Error` whose `code` is one of {{cf.bridgeErrors}}.
  Catch every call and show `e.message` where it happened (that row, that button):
  - `gesture`: called outside a click or key press: move the call into the handler.
  - `declined`: the user said no in the app's dialog: put the row back, no alarm.
  - `unavailable`: no such verb here, or the page is not shown in its thread: say so.
  - `invalid`: a wrong verb or arg: fix the call (`code-foundry help <verb>`).
  - `failed`: the command ran and failed: show the message, keep the rest working.
  - `timeout`: no answer in 60 s (`cf.run(verb, args, {timeout: ms})`, 0 waits): offer
    a retry.

## Verbs pages use

Their args by name (values after them in plain text); `code-foundry help <verb>` has the rest.

| Verb | Args |
|---|---|
| `pr.merge` (asks first) | `repo-slug`, `number`, `method` merge, squash or rebase, `head-sha` the PR's `headSha` |
| `pr.checks` (read) | `repo-slug`, `number`; watch one PR: run it again in `cf.on("gh", …)` |
| `thread.archive` (asks when busy) | `id`; `archived` false unarchives |
| `thread.snooze` | `id`, `until` 1h, 3h, tomorrow, next-week, mon…sun or a date; or `clear` true |
| `thread.pin`, `thread.send` | `id`; `pinned` true or false; `text` the message |
| `thread.new` | `prompt`, `name`, `project` id, `new-worktree` true, `sidebar` true |
| `settings.get` (read), `settings.set` | `key`; `value` as a string |
| `usage.show` (read) | `thread` an id, or `all` true |
| `view.open.url` | `url`: opens it in the user's browser (a plain link works too) |

## Live data: cf.on, never polling

`cf.on(source, fn)` calls `fn(value)` with the source's whole current value at once (when
there is one) and again after every change. Never `setInterval` and never re-run reads
on a timer: for what only a verb has (`pr.checks`, `usage.show`), re-run the read inside
a `cf.on` callback. Times are epoch milliseconds (`…AtMs`).

- `thread-list`: the user's threads in sidebar order, each `id`, `name`, `status` (busy,
  idle, attention, error), `statusReason`, `pinned`, `archivedAtMs` and `snoozedUntilMs`
  (null unless archived or snoozed: filter those out of a board), `projectId`,
  `worktreePath`, `model`, `effort`, `costUsd`, `usage` (buckets of `model`, `day`
  YYYY-MM-DD, `requests`, `input`, `output`, `costUsd`), `createdAtMs`,
  `lastActivityAtMs`, `parentId`, `createdBy`, `labels`.
- `thread`: `{thread, pending}`: this thread's own row (as above) and the requests it waits
  on (`summary`, `question`, `toolName`).
- `gh`: the pull requests of the user's projects: `{authenticated, viewer: {login},
  authored, reviewRequested, reviewed, recentlyMerged, fetchedAtMs, lastError}`, nothing
  until the first read. `authored` is the user's open PRs. Each PR: `repoSlug`, `number`,
  `title`, `url`, `author`, `draft`, `headRef`, `headSha`, `baseRef`, `review` (approved,
  changes_requested, review_required, null), `checks` (`state` success, failure, pending,
  error, none; `total`, `passed`, `failed`, `pending`), `mergeable` (mergeable,
  conflicting, unknown), `mergeState` (clean, blocked, behind…). Green: `checks.state`
  success, not a draft, `mergeable` not conflicting.
- `settings`: `{values, revision, issues, restartPending}`; `values` maps every key
  (`appearance.font_size`) to its value as a string. `settings.set` changes one.
- `project`: projects with `id`, `name`, `path`, `githubSlug`, `defaultBranch`, `worktrees`.
- `action` (`{actions, runs}`), `terminal`, `workspace`, `plugin`: arrays of their items;
  `update`: the app update (`state`, `currentVersion`, `latestVersion`); `ember`: Ember's
  board while the app shows it; `ui`: app notices as they happen (no first value).

## State

`cf.storage("<page name>")`, after `await cf.ready`: `get`, `set`, `remove`, `keys`,
`clear`, JSON values. It persists across reloads and restarts: keep what the user typed or
chose there (a filter, a token, a draft), not what a source sends. Every page shares one
origin, so other pages can read it: prefix it, and never trust what you did not write.

## Limits

- **On screen only.** A closed card, a scrolled-away row or another thread stops the page;
  shown again it reloads. Background or repeated work is a plugin.
- **No sign-in.** SSO and OAuth redirects fail in the frame, and it has none of the user's
  browser cookies. For an external API (Linear, Jira, Sentry) ask the user to paste an API
  token into a password field, keep it in `cf.storage`, send it in `fetch` headers; never
  in the file. The API must allow cross-origin calls; if not, say a plugin is needed.
- **No API of its own.** The page holds no Code Foundry token: everything goes through `cf.run`.

## Show it, then say what it does

Run `code-foundry view.inline <path> --title "<what it is>"` and fix every warning it
prints. An edit with your Edit or Write tool reloads the card already shown. Reply in two
or three sentences: what it shows, what each button does, that the app asks before merging
or archiving. You have not clicked anything: never say it worked.
