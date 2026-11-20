---
name: code-foundry-pages
description: "Build an HTML or React page that reads Code Foundry live and acts on it through /cf/bridge.js: merge PRs, archive or start threads. Use when the user wants a page, dashboard, board, tracker, form, chart or tool; a checklist or to-do to tick off; to see what's running, what's going on or their work (threads, PRs: not the Mac's processes); something as UI or a mockup; or a page of yours misbehaves."
---

# Pages that use Code Foundry

{{cf.provenance}}

A page is one `.html` file in `$CODE_FOUNDRY_PAGES` (this thread's folder, never the repository or
home folder; read nothing in other threads' folders or the app's home), shown with
`code-foundry view.inline <path>` in this conversation, in the user's theme. With `/cf/bridge.js`
it reads the app live and runs the CLI's commands as this thread.

**Read first**, whole: `reference/components.md` (`@cf/ui`) and `reference/react.md`. Grep the
rest: `sources.md` (sources' fields, storage, `cf.fetch`; contents at the top), `verbs.md`,
`errors-and-limits.md`, `examples.md` (whole pages, plain HTML too), `welcome.md` (first run).

## Page, wake, plugin or reply

A page is to look at and click. To be told, reminded or have it done later or again: a wake,
`thread subscribe` (`--pr owner/name#4 --until checks_passed`, `--every 1h`), never cron or a
`--watch` loop. With no thread, as its own tab or on every new PR: a plugin (the
code-foundry-plugin skill). One answer: a reply.

## Before you write it

1. Find the verbs (`reference/verbs.md`, `daemon.capabilities --group commands`) and their
   args (`code-foundry help <verb>`); a setting's range: the code-foundry-help skill's
   `reference/settings.md` (never try values on the user's real settings).
2. Two shapes, never mixed. `cf.run` resolves `json`: what the verb prints with `--json` (run
   it in Bash: THREAD_STATUS_IDLE, ISO times, zero fields left out). `cf.on` sends the app's
   view models: lower-case values (idle), times as epoch ms in `…AtMs` (`new Date(ms)`), every
   field there. Use only names from `--json` or `reference/sources.md`; never guess.
3. One file, no build step, no CDN: React (below), or plain DOM for something tiny (`reference/examples.md`).
4. Paint only with `@cf/ui`, `/cf/ui.css`'s classes or `/cf/theme.css`'s `--cf-<name>` variables:
   `canvas`, `surface`, `surface-raised`, `text`, `text-muted`, `accent`, `border`, and `success`,
   `warning`, `error` (text `-text`, tint `-surface`). Each is a class: `bg-`, `text-`, `border-cf-<name>`
   (`text-cf-text-muted`, `hover:bg-cf-surface-raised`). `ui.css` is a fixed
   set, not all of Tailwind: those, the type roles (`text-title`, `text-body`…), layout, spacing,
   sizes in 4px steps (`min-h-112`), `rounded-*`. No arbitrary values (`w-[217px]`), `line-through`
   or `font-mono`: view.inline names each class it lacks; use a `style`, your own `<style>`, or
   `/cf/tailwind.js` for all of Tailwind. Never fixed colours or `prefers-color-scheme`, unless
   mocking up another product.

## The skeleton

Only the components `reference/components.md` names; icons from `@cf/icons` (lucide).

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<link rel="stylesheet" href="/cf/ui.css">
<script src="/cf/bridge.js"></script> <!-- follows theme switches, sizes the card: no code for either -->
<script src="/cf/jsx.js"></script> <!-- runs text/tsx scripts, shows errors -->
<body class="text-body"><div id="root"></div>
<script type="text/tsx">
  import { useEffect, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { Button } from "@cf/ui";
  import { Archive } from "@cf/icons";
  await cf.ready; // cf.thread and cf.readOnly are set now
  function App() { /* useEffect(() => cf.on("thread-list", setThreads, (e) => setError(e.message)), []) */ }
  createRoot(document.getElementById("root")!).render(<App />);
</script>
```

A **mockup of another product** ("make it look real"): leave out both stylesheets, keep
`/cf/bridge.js` (`react.md`).

## The bridge

```
{{cf.bridgeAPI}}
```

- `cf.run(verb, args)`: the dotted verb (`pr.merge`) and its flags by name, without the
  dashes, positional ones too: `cf.run("pr.merge", {"repo-slug": pr.repoSlug, number:
  pr.number, method: "squash", "head-sha": pr.headSha})`. Values are strings, numbers or
  booleans. Never pass `yes` or `force`: the app's dialog decides.
- **Reads run any time** (on load, from `cf.on`): `cf.readOnly` lists them (thread.get, thread.list, usage.show, pr.checks, settings.get).
- **Every other verb runs only from a click or key press in the page**: in the `click` (or
  `submit`) handler, never on load, from a timer or from `cf.on`. The press counts for 5 seconds:
  start the call before any slow await. For several, start them all in the handler: `await Promise.all(items.map((x) => cf.run(…)))`; a slider on `change`, not `input`.
- **The app asks the user** before a verb that needs it, or that runs a program, saves a file, writes to git or GitHub or installs code, in its own dialog: add no `confirm()`. One question at a time, 5 s apart, 3 a minute (more reject `invalid`): ask from one button, not a loop.
- **On success** update that row at once, in your own words: never print `text`.
- **This thread**: pass `id` (`id: cf.thread?.id` for the page's own: without one, archive, remove and snooze
  refuse it). Leave `cf.thread?.id` out of lists of threads to act on: archiving it closes the page.
  It may archive any thread; unarchive (or message, pin, snooze an archived one) only those this one created.
- **Threads a page starts** (`thread.new`) are this thread's hidden children (`"created-by": ""` and a `project` id: the user's own);
  pass a `prompt` and a `request-id` per row (a second click resolves with the same thread).
- **Errors**: catch every `cf.run`; show `e.message` where it happened (that row), never in `alert()` (it shows nothing).
  `e.code` says what to do (`reference/errors-and-limits.md`); `declined` is the user's no, not an error.

## Live data: cf.on, never polling

`cf.on(source, fn, onError)`: show `onError(e)`'s `e.message` in the page. `cf.off(source)` (or what `cf.on`
returns) stops it. Never poll the app on a timer for what `cf.on` sends: re-run a read (`pr.checks`)
inside a `cf.on` callback. A timer that only redraws (a clock, "5m ago") or refetches an external
API with `cf.fetch` (a minute or more apart) is fine. A board of threads groups them as the
sidebar does (`sources.md`).
Sources: `thread-list`, `thread` (this one), `gh` (PRs), `action`, `plugin`, `terminal`, `project`,
`workspace`, `settings`, `update`, `ui`, `ember` (only while Ember is open; else show its message).

**Rows stay put** between updates: sort by id or the user's order, re-sort only on a Refresh
click or while nothing is hovered; a button acts on the id its row was drawn with.

## State

`cf.storage("<page name>")` (`get`, `set`, `remove`, `keys`, `clear`) keeps what the user
chose across restarts, one per page file, shared by its card and tabs; 256 KiB in all, any value
size within that (1 KiB caps a key's name). Draw from it in a `draw()` called after each `set`
and passed to `s.onChange(draw)` (now, and on another copy's change). A hidden page (another tab
or space in front) is unloaded and loads afresh when shown: keep there what should survive (a
draft, the chosen tab). Fetched data: store the last good result and its time, show it at once and
refetch. Raw `localStorage` is cleared when the app quits; an API token goes in a password
field, then `cf.storage`. A moved or renamed file starts empty; removing this thread deletes its
pages and their storage (archiving keeps both).

## Show it, then say what it does

Run `code-foundry view.inline <path> --title "<what it is>"` once per file and fix warnings
in place: the card reloads on each edit, so never show it again, not even for "show me"
(`--panel` opens it beside the thread). Then run
`code-foundry page.check <path> --shot out.png` after each edit until it is clean. Reply in 2-3 sentences: what it shows, what each
button does, that the app asks before merging or archiving; for "track" or "watch", that it
updates only while shown (offer a wake). The check clicks nothing: never say a button works.
