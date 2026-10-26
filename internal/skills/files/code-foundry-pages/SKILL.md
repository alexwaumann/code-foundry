---
name: code-foundry-pages
description: "Build an HTML or React page that reads Code Foundry live and acts on it through /cf/bridge.js: merge PRs, archive or start threads. Use when the user wants a page, dashboard, board, tracker, form, chart or tool; a checklist or to-do to tick off; to see what's running, what's going on or their work (threads, PRs: not the Mac's processes); something as UI or a mockup; or a page of yours misbehaves."
---

# Pages that use Code Foundry

{{cf.provenance}}

A page is one `.html` file in `$CODE_FOUNDRY_PAGES` (this thread's folder: read nothing in
other threads' folders or the app's home), shown with `code-foundry view.inline <path>`:
interactive, in this conversation, in the user's theme. With `/cf/bridge.js` it reads the app
live and runs the CLI's commands as this thread. Beside this file, in `reference/`:
`examples.md` (complete pages), `verbs.md` (the verbs pages use), `sources.md` (`cf.on` fields,
storage, `cf.fetch`), `react.md` (React, mockups, Tailwind), `components.md` (`@cf/ui`).

## Page, wake, plugin or reply

- **A page** when the user wants something to look at or click: a list with buttons, a
  board, a form, a live chart, a slider. It runs only while it is on screen.
- **A wake** when the user wants to be told, reminded or have it done later or again ("tell
  me when #4's checks pass", "every hour archive idle threads", "keep an eye on my threads"):
  `code-foundry thread subscribe --pr owner/name#4 --until checks_passed`, `--every 1h`,
  `--at 2h` or `--thread <id> --until attention --repeat`, `--note` what to do; end your turn
  and the app wakes this thread, even stopped. Never Claude Code's own cron or a `--watch`
  loop: the app stops idle threads, and those die too.
- **A plugin** (the code-foundry-plugin skill) when it must work with no thread at all, as
  its own side panel tab, or on every new PR in every project.
- **A plain reply** when one answer is enough ("which PRs are green?").

## Before you write it

1. Find the verbs (`reference/verbs.md`, `daemon.capabilities --group commands`) and their
   args (`code-foundry help <verb>`); a setting's range is in the code-foundry-help skill's
   `reference/settings.md`: never try values on the user's real settings to find a limit.
2. Two shapes, never mixed. `cf.run` resolves `json`: what the verb prints with `--json` (run
   it in Bash: THREAD_STATUS_IDLE, ISO times, zero fields left out). `cf.on` sends the app's
   view models: lower-case values (idle), times as epoch ms in `…AtMs` (`new Date(ms)`), every
   field there. Use only names from `--json` or `reference/sources.md`; never guess.
3. One file, no build step, no CDN: React (below) unless it is tiny. Paint only with
   `--cf-*` variables, the type-role classes (the code-foundry skill names them) or `@cf/ui`,
   never fixed colours, unless it mocks up another product.

## Plain HTML or React

**Plain HTML** only for something tiny and static (one figure, a chart, a short form): plain
DOM, inline CSS, `<script type="module">` (top-level `await` works).

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<script src="/cf/bridge.js"></script> <!-- follows theme switches, sizes the card: no cf:theme or cf:resize code -->
<body class="text-body">
<div id="out">Loading…</div>
<script type="module">
  await cf.ready;                       // cf.thread, cf.theme and cf.readOnly are set now
  const out = document.getElementById("out");
  const shown = (e) => { out.textContent = e.message; };  // a refusal, in the page
  cf.on("thread-list", (threads) => { out.textContent = threads.length + " threads"; }, shown);
</script>
```

**React with `@cf/ui`** for the rest: a board, a list with actions, a dashboard, anything with
state, filters, dialogs, tabs or tables. The app's own components (only the names in
`reference/components.md`, read it and `reference/react.md` first), `@cf/icons` (lucide), TSX via `/cf/jsx.js`.

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<link rel="stylesheet" href="/cf/ui.css"> <!-- the components' styles and the app's utilities -->
<script src="/cf/bridge.js"></script>
<script src="/cf/jsx.js"></script> <!-- the import map; runs text/tsx scripts in order, shows errors -->
<body class="text-body"><div id="root"></div>
<script type="text/tsx">
  import { useEffect, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { Button, Table, TableBody, TableCell, TableRow } from "@cf/ui";
  import { Archive } from "@cf/icons";
  await cf.ready;
  function App() { /* useEffect(() => cf.on("thread-list", setThreads, (e) => setError(e.message)), []) */ }
  createRoot(document.getElementById("root")!).render(<App />);
</script>
```

A **mockup of another product** ("make it look real, not like Code Foundry"): leave out both
stylesheets and write its own CSS (or `/cf/tailwind.js`, any Tailwind utility, its own colours);
React and `@cf/icons` still work; keep `/cf/bridge.js`, it sizes the card.

## The bridge

```
{{cf.bridgeAPI}}
```

- `cf.run(verb, args)`: the dotted verb (`pr.merge`) and its flags by name, without the
  dashes, positional ones too: `cf.run("pr.merge", {"repo-slug": pr.repoSlug, number:
  pr.number, method: "squash", "head-sha": pr.headSha})`. Values are strings, numbers or
  booleans (sent as strings). Never pass `yes` or `force`: the app's dialog decides.
- **Reads run any time** (on load, from `cf.on`): `cf.readOnly` lists them (thread.get, thread.list, usage.show, pr.checks, settings.get…).
- **Every other verb runs only from a click or key press in the page.** Call `cf.run`
  inside the button's `click` (or a form's `submit`) handler; never on load, from a timer
  or from `cf.on`. The press, click or key counts for 5 seconds: a quick read awaited first
  is fine, anything slower first (a long wait, a timer) loses it. For several, start them all
  in the handler: `await Promise.all(items.map((x) => cf.run(…)))`; a slider on `change`, not `input`.
- **The app asks the user** before a verb that needs it: its own dialog opens over the page. Add no `confirm()`.
- **On success** update that row from the result at once in your own words: never print `text`.
- **This thread**: pass `id` (`id: cf.thread.id` for the page's own: without one, archive, remove and snooze
  refuse it). Leave `cf.thread.id` out of lists of threads to act on: archiving it closes the page.
- **Threads a page starts** (`thread.new`) are hidden children: pass `sidebar: true` when the user will want
  them, a `prompt`, and a `request-id` per row: a second click then resolves with the same thread, a success.
- **Errors**: `cf.run` rejects with an `Error` whose `code` is one of {{cf.bridgeErrors}}.
  Catch every call and show `e.message` where it happened (that row, that button):
  - `gesture`: called outside a click or key press: move the call into the handler.
  - `declined`: the user said no: not an error. Button back, at most a muted "Not merged".
  - `unavailable`: no such verb, no thread, or (from `cf.on`) a source the app lacks now.
  - `invalid`: a wrong or missing arg: fix the call (`code-foundry help <verb>`).
  - `failed`: the command ran and failed: show the message, keep the rest working.
  - `timeout`: no answer in 60 s (`{timeout: ms}` as a third arg, 0 waits): offer a retry.

## Live data: cf.on, never polling

`cf.on(source, fn, onError)` calls `fn(value)` with the whole value now and after every change;
`onError(e)` gets a refusal: show `e.message` in the page. `cf.off(source)` (or what `cf.on`
returns) stops it. Never `setInterval`: re-run a read (`pr.checks`) inside a `cf.on` callback.
Sources (fields: `reference/sources.md`): `thread-list`, `thread` (this one), `gh` (open and recently
merged PRs), `action`, `plugin`, `terminal`, `project`, `workspace`, `settings`, `update`, `ui` and
`ember` (only while Ember is open; else show its message).

**Rows stay put** between updates: sort by id or keep the user's order, re-sort on a Refresh
click or while nothing is hovered. A button acts on its row's id from when it was drawn.

## State and limits

- `cf.storage("<page name>")` (`get`, `set`, `remove`, `keys`, `clear`, JSON values) survives reloads and
  app restarts: keep what the user typed or chose. Every page of this thread shares it; the same file in
  another thread starts empty. Plain `localStorage` is cleared when the app quits.
- **On screen only.** A closed card, a scrolled-away row or another thread stops the page.
- **No sign-in.** SSO and OAuth redirects fail. For an external API ask the user
  to paste an API token into a password field, keep it in `cf.storage`, send it in a header
  with `cf.fetch` (CORS never blocks it). Plain `fetch` only for an API known to allow any origin.
- **Data a source lacks** (closed PRs, another repo): a read verb through `cf.run`, else the
  service's API through `cf.fetch`. A plugin cannot feed a page: never offer it.

## Show it, then say what it does

Run `code-foundry view.inline <path> --title "<what it is>"` once per file; fix every
warning it prints by editing the file in place: the card shown reloads by itself, so never
run view.inline for that file again, not even for "show me" after an edit (`--panel` opens
it beside the thread). Reply in two or three sentences: what it shows, what each button
does, that the app asks before merging or archiving; for "track" or "watch", that it
updates only while shown (offer a wake). You have not clicked anything: never say it worked.
