# Page bridge messages (fuzz pass fixes)

What the bridge tells a page, and through it the Claude that wrote the page, after the
2026-11-19 fuzz pass of HTML pages. Each fix was reproduced on a scratch dev daemon first and
checked there again after, in `playwright cli` (WebKit).

## What was wrong, and the rule now

- **A name that is no command was told it needs a click.** bridge.js refused every verb not
  in `cf.readOnly` outside a gesture, so `cf.run("thread.lst")` on load said "changes
  something, so it runs only from a click", and the page's author moved a misspelt read into
  a button. `cf:ready` now carries `verbs`, every command's name. bridge.js asks for the
  gesture only for a name in it; any other name goes to the host, which answers `unavailable:
  unknown command "thread.lst": cf.readOnly lists the reads, and code-foundry help the rest`
  before its own gesture check, whether the user clicked or not, and the error badge counts it.
  An app without `verbs` keeps the old behaviour. An empty command list (the daemon did
  not answer) leaves the name to the daemon, as before.
- **A refused page's reads were told they need a click.** A page the user did not allow (or
  that is no page: outside home) gets `readOnly: []`, so every verb looked like a mutation.
  bridge.js now sends a refused page's runs to the host (no gesture check when `cf:ready` has
  a `refusal`), which answers with the refusal: "the user has not allowed this page to use
  Code Foundry".
- **The gesture message did not say 5 s.** A call in a click handler after a slow await was
  told it must come from a click. Both bridge.js and the host now say "runs only within 5 s
  of a click or key press in the page: start it in the handler, before slow awaits".
- **A page no thread owns lost the bridge on a link to its own next file.** The HTML spec turns
  the Navigation API's events off in a document of an opaque origin, which is the sandbox of
  every threadless page since #845: no `navigate` event came, so the nonce was never carried.
  The follow block now uses the click fallback when `window.origin` is "null" (a followed
  link, as a browser without the API). A script's `location = …` in such a frame still goes
  without the nonce; errors-and-limits.md now says "by a link". The sandbox is unchanged.
- **"Script error." for a React render error on a page no thread owns.** React reports an
  uncaught render or event handler error through `window.reportError`, from
  `/cf/react-dom-client.js`; the opaque frame's error event then has "Script error." and no
  error. jsx.js wraps `reportError` before React's modules load (they read it once, at
  evaluation) and keeps what it was handed while the event dispatches, so the box shows the
  real message and stack. An error event with nothing behind it says the browser hid the
  message and what to look for. react.md's board, SKILL.md and the welcome page now read
  `cf.thread?.id`.
- **Small ones.** A timeout under 10 s is said in tenths ("1.5 s", not "2 s"). The
  too-large message says the 256 KiB is all args together and that base64 grows bytes by a
  third. A refused storage write takes its key back at once (keys() and clear() right after it
  no longer see it), unless a later write of the key is still on the way.
- **Docs made true.** `unavailable` also means a thread, PR or repo that does not exist.
  `cf.fetch` reaches a dev server on this Mac through its LAN address when it listens on all
  interfaces (proxyfetch refuses this Mac's interface addresses only on the daemon's own
  ports, deliberately; the rule is unchanged). Storage is 256 KiB per thread across its pages,
  and the 1 KiB key limit includes the prefix and ":". A loop of asking calls gets one of them
  asked, not the first. `file.export`'s 256 KiB is the whole call (about 190 KiB of bytes as
  base64). `view.open.page` needs an absolute path, which a page cannot read from `location`.
- **ui.css's layer order.** frame.css (loaded first, through theme.css) named `theme, base,
  components, utilities` but not `properties`, which ui.css opens next, so `properties` sorted
  above `utilities`. In a WebKit without `margin-trim`, Tailwind's `--tw-*` fallbacks
  (`@supports` in `properties`) then beat every translate, shadow and ring utility: a Dialog
  opened off centre and clipped. The shipped app's WKWebView is the system's (Safari 27 on
  macOS 27 here), which has `margin-trim`, so users on a current macOS never saw it. The
  Playwright WebKit that drive, e2e and sketches use does not have it. frame.css now opens
  with `@layer properties, theme, base, components, utilities;`, as Tailwind orders them.
- **drive-app and React pages.** The drive config's origin allowlist aborts `blob:` URLs, the
  ones jsx.js imports each compiled script from. The skill now gives the `run-code` route that
  lets them through (an allowed-origins glob cannot express `blob:`).

## Declined

- **The archived-thread refusal's CLI advice in a page** (`thread X is archived …: Read it
  instead (code-foundry thread read X)`). The thread store cannot tell a page from its thread:
  a page acts as its thread, and the refusal is right for that thread's Claude. Page-specific
  wording needs the caller's origin carried into the thread store, which is outside this
  change, and the case is rare (a board acting on a row it just archived).

## Gotchas

- The host's command list is `includeUnavailable: true`, so `verbs` is every registered
  command (aliases are registered commands too). It is the same list `readOnly` is read from.
- WebKit's `reportError` fires the error event synchronously, which is what lets jsx.js pair
  the event with the error it was handed. Errors that never pass through `reportError` (a throw
  straight out of a cross-origin script's own timer) still read "Script error.", now with the
  explanation.
- Verified with the origin/main daemon and this branch's GUI for the before shots. Every
  before path is page-side (bridge.js, jsx.js, frame.css), so the old daemon shows the old
  behaviour.
