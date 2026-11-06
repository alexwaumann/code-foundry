# Errors and limits

{{cf.provenance}}

For the code-foundry-pages skill.

## Errors

`cf.run` rejects with an `Error` whose `code` is one of {{cf.bridgeErrors}}. Catch every call and
show `e.message` where it happened (that row, that button):

  - `gesture`: called outside a click or key press: move the call into the handler.
  - `declined`: the user said no: not an error. Button back, at most a muted "Not merged".
  - `unavailable`: no such verb, no thread, or (from `cf.on`) a source the app lacks now.
  - `invalid`: a wrong or missing arg: fix the call (`code-foundry help <verb>`).
  - `failed`: the command ran and failed: show the message, keep the rest working.
  - `timeout`: no answer in 60 s (`{timeout: ms}` as a third arg, 0 waits): offer a retry.

## Limits

- **On screen only.** A page runs only while it is on screen: a closed card, a scrolled-away row or
  another thread stops it. To be told or have it done later, that is a wake.
- **No sign-in.** SSO and OAuth redirects fail. For an external API ask the user to paste an API
  token into a password field, keep it in `cf.storage`, send it in a header with `cf.fetch` (CORS
  never blocks it). Plain `fetch` only for an API known to allow any origin.
- **Storage is per thread.** The same file in another thread starts empty.
- **Data a source lacks** (closed PRs, another repo): a read verb through `cf.run`, else the
  service's API through `cf.fetch`. A plugin cannot feed a page: never offer it.
