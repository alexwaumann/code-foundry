---
name: code-foundry-pages
description: "Build an HTML page that reads Code Foundry live and acts on it through /cf/bridge.js: a dashboard, board, tracker, form, chart, checklist or tool in the conversation (merge PRs, archive or start threads, change a setting). Use when the user wants a page, dashboard, form, chart, tool, checklist, board or tracker, asks to see something as UI, or a page of yours misbehaves."
---

# Pages that use Code Foundry

{{cf.provenance}}

A page is one `.html` file you write in `$CODE_FOUNDRY_PAGES` and show with
`code-foundry view.inline <path>`: interactive, in this conversation, in the user's theme.
With `/cf/bridge.js` it reads the app live and runs the commands you run with the CLI, as
this thread. Beside this file: `reference/examples.md` (complete pages) and
`reference/sources.md` (every field each `cf.on` source sends).

## Page, wake, plugin or reply

- **A page** when the user wants something to look at or click: a list with buttons, a
  board, a form, a live chart, a slider. It runs only while it is on screen.
- **A wake** when the user wants to be told, reminded or have it done later or again
  ("tell me when #4's checks pass", "every hour archive idle threads", "keep an eye on my
  threads"): `code-foundry thread subscribe --pr owner/name#4 --until checks_passed`,
  `--every 1h`, `--at 2h` or `--thread <id> --until attention --repeat`, with `--note`
  what to do; end your turn and the app wakes this thread, even stopped. Never Claude
  Code's own cron or a `--watch` loop: the app stops idle threads, and those die too.
- **A plugin** (the code-foundry-plugin skill) when it must work with no thread at all, as
  a side panel tab of its own, or on every new PR in every project.
- **A plain reply** when one answer is enough ("which PRs are green?").

## Before you write it

1. Find the verbs ("Verbs pages use" below, `daemon.capabilities --group commands`) and
   their args (`code-foundry help <verb>`).
2. Two shapes, never mixed. `cf.run` resolves `json`: what the verb prints with `--json`
   (run it in Bash to see it: THREAD_STATUS_IDLE, ISO times, zero fields left out).
   `cf.on` sends the app's view models: lower-case values (idle), times as epoch ms in
   `…AtMs` (`new Date(ms)`), every field there. Use only names from `--json` or
   `reference/sources.md`; never guess.
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
  booleans (sent as strings). Never pass `yes` or `force`: the app's dialog decides.
- **Reads run any time** (on load, from `cf.on`): `cf.readOnly` lists them (thread.get,
  thread.list, usage.show, pr.checks, settings.get…).
- **Every other verb runs only from a click or key press in the page.** Call `cf.run`
  inside the button's `click` (or a form's `submit`) handler; never on load, from a timer
  or from `cf.on`. The click counts for a few seconds (WebKit's user activation, about 5):
  a quick read awaited first is fine, anything slow first (a wait, a timer) loses it. For
  several, start them all in the handler: `await Promise.all(items.map((x) => cf.run(…)))`.
  A slider acts on `change`, not `input`.
- **The app asks the user** before a verb that needs it (merging a PR, archiving a busy
  thread): its own dialog opens over the page. Add no `confirm()` of your own.
- **On success** update that row from the result at once (merged, archived): the sources
  catch up on their own, `gh` up to a minute later.
- **This thread**: pass `id` (`id: cf.thread.id` for the page's own thread: without one,
  archive, remove and snooze refuse it). Leave `cf.thread.id` out of lists of threads to
  act on: archiving the page's own thread closes the page.
- **Threads a page starts** (`thread.new`) are this thread's children, hidden from the
  sidebar: pass `sidebar: true` when the user will want to see them, and a `prompt`.
- **Errors**: `cf.run` rejects with an `Error` whose `code` is one of {{cf.bridgeErrors}}.
  Catch every call and show `e.message` where it happened (that row, that button):
  - `gesture`: called outside a click or key press: move the call into the handler.
  - `declined`: the user said no in the app's dialog: put the row back, no alarm.
  - `unavailable`: no such verb, the page is not shown in its thread, or (from `cf.on`)
    the app does not hold that source now: show the message.
  - `invalid`: a wrong or missing arg: fix the call (`code-foundry help <verb>`).
  - `failed`: the command ran and failed: show the message, keep the rest working.
  - `timeout`: no answer in 60 s (`{timeout: ms}` as a third arg, 0 waits): offer a retry.

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

`cf.on(source, fn, onError)` calls `fn(value)` with the whole current value at once (when
there is one) and after every change. Never `setInterval` or reads on a timer: re-run a
verb's read (`pr.checks`, `usage.show`) inside a `cf.on` callback. Sources (read their
fields in `reference/sources.md`): `thread-list`, `thread` (this one and what it waits
on), `gh` (open and recently merged PRs), `action`, `plugin`, `terminal`, `project`,
`workspace`, `settings`, `update`, `ui` (notices) and `ember` (only while Ember is open in
the app; else onError gets `unavailable`: show its message, never an empty board).

## State

`cf.storage("<page name>")`, after `await cf.ready`: `get`, `set`, `remove`, `keys`,
`clear`, JSON values. Code Foundry keeps it for the thread (up to 256 KiB), so it survives
reloads and app restarts; keep what the user typed or chose (a filter, a token, a draft),
not what a source sends. Every page of this thread shares it (one prefix each; the same
file in another thread starts empty): never trust what you did not write. `get` and `keys`
answer at once; `set`, `remove`, `clear` return a Promise that rejects when it is full.
Plain `localStorage` is cleared when the app quits, so keep nothing there.

## Limits

- **On screen only.** A closed card, a scrolled-away row or another thread stops the page;
  shown again it reloads. Background or repeated work is a plugin.
- **No sign-in.** SSO and OAuth redirects fail in the frame, and it has none of the user's
  browser cookies. For an external API (Linear, Jira, Sentry) ask the user to paste an API
  token into a password field, keep it in `cf.storage`, send it in `fetch` headers; never
  in the file. The API must allow cross-origin calls; if not, say a plugin is needed.
- **No API of its own.** The page holds no Code Foundry token: everything goes through `cf.run`.
- **Data a source lacks** (closed PRs, another repository): a read verb that has it
  (`--group commands`, `help <verb>`) through `cf.run`, else the service's API with a
  token the user pastes, as above (GitHub's allows cross-origin calls). A plugin cannot
  feed a page: never offer that.

## Show it, then say what it does

Run `code-foundry view.inline <path> --title "<what it is>"` once per file; fix every
warning it prints by editing the file in place: the card shown reloads by itself, so never
run view.inline for that file again, not even for "show me" after an edit (`--panel` opens
it beside the thread). Reply in two or three sentences: what it shows, what each button
does, that the app asks before merging or archiving; for "track" or "watch", that it
updates only while shown (offer a wake). You have not clicked anything: never say it worked.
