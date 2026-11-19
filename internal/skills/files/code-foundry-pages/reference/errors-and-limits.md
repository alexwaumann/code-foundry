# Errors and limits

{{cf.provenance}}

For the code-foundry-pages skill.

## Errors

`cf.run` rejects with an `Error` whose `code` is one of {{cf.bridgeErrors}}. Catch every call and
show `e.message` in the page where it happened (that row, that button); `alert()`, `confirm()` and
`prompt()` show nothing in the app:

  - `gesture`: called outside a click or key press: move the call into the handler.
  - `declined`: the user said no: not an error. Button back, at most a muted "Not merged".
  - `unavailable`: no such verb, the user has not allowed the page, a call that needs a thread
    from a page with none, or (from `cf.on`) a source the app lacks now.
  - `invalid`: a wrong or missing arg: fix the call (`code-foundry help <verb>`). Also a second
    question while one is open, or too soon after a no (the message says how long): ask once
    per press.
  - `failed`: the command ran and failed: show the message, keep the rest working.
  - `timeout`: no answer in 60 s (`{timeout: ms}` as a third arg, 0 waits): offer a retry.

## Limits

- **On screen only.** A page runs only while it is on screen: a closed card, a scrolled-away row or
  another thread stops it. To be told or have it done later, that is a wake.
- **No sign-in.** SSO and OAuth redirects fail. For an external API ask the user to paste an API
  token into a password field, keep it in `cf.storage`, send it in a header with `cf.fetch` (CORS
  never blocks it). Plain `fetch` only for an API known to allow any origin.
- **Links leave for the browser.** A link to another site, `window.open` and a GET form open in the
  user's browser (after a click; the page stays). A POST form or a script's `location` to another
  site goes nowhere: send it with `cf.fetch`. Another file of the page loads in the frame, bridge and all.
- **No dialogs, no downloads.** `alert()` shows nothing, `confirm()` answers false and `prompt()`
  null: ask in the page (`Dialog` from `@cf/ui`). A `download` link or a file made in script saves
  nothing: save it with `file.export` from the click (`verbs.md`) and show the path it answers.
  Each one shows in the page's error badge.
- **Storage is per thread.** A page belongs to the thread that last showed or wrote it (its
  bridge acts as that thread in any tab); shown by another thread, it starts empty there.
- **A page no thread owns** (the user opened a file a script wrote) asks the user once whether it
  may use Code Foundry; `cf.ready` waits for the answer. Allowed: `cf.thread` is null, `cf.storage`
  is its own (per file), `cf.fetch` works, a verb runs with no thread (pass ids: `thread.get` needs
  `id`), every source but `thread`. Not allowed: every call is refused, saying so.
- **Data a source lacks** (closed PRs, another repo): a read verb through `cf.run`, else the
  service's API through `cf.fetch`. A plugin cannot feed a page: never offer it.
