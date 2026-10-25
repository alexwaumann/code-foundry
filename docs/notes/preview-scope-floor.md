# HTML preview: a floor under the grant scope, and CORS for the app only (2026-10-21)

A fuzz pass found that previewing `~/report.html` (where a no-project thread, cwd `$HOME`,
writes its HTML) minted a grant scoped to the whole home directory. The page could fetch
`~/.code-foundry/daemon.token` and any other home file through it, and because the loopback
CORS layer reflected the frame's opaque `null` origin, it could then call
`TerminalService/Create` with that token and run commands. Proven end to end in WebKit
with the shipped sandbox attributes; reproduced again on main before this change.

## The rule

* **`preview.Floor`** (`internal/preview/floor.go`) is what a grant may never reach:
  * *guarded* trees: the config home (`CODE_FOUNDRY_HOME`, symlinks resolved) except its
    `worktrees/` and `projects/` (Code Foundry's own checkouts live there and must stay
    previewable), and the credential paths under home: `.ssh .gnupg .aws .azure .kube
    .docker .config .claude .claude.json .netrc .git-credentials .npmrc .pypirc Library`.
  * a *scope* (a grant's whole tree) must be strictly below home, not guarded, and contain
    nothing guarded. So never `$HOME`, never an ancestor of the config home (a custom
    `CODE_FOUNDRY_HOME=~/dev/cf` rules out `~/dev` as a scope), never `~/.ssh/...`.
* **`previewScope`** picks the deepest registered checkout holding the file that clears the
  floor (a project registered at `~` itself is skipped), else the file's directory if it
  clears it, else a **one-file grant**: `Grants.GrantFile` serves that file and nothing
  else (`entry{dir, file}`; the route 404s every other path). `PreviewFileResponse`
  gained `single_file`; `scope` is then the file itself and the footer says "loads this
  file only". Relative assets of such a page do not load; moving it into a folder or a
  project fixes that, which is the intended nudge.
* A file that is itself guarded, or whose symlinks lead into a guarded tree, is refused
  with InvalidArgument: "… is in a protected folder (Code Foundry's own data, credentials
  or ~/Library), so it cannot be previewed". The GUI shows it in the tab's error state.
* **Defence in depth at the route:** after resolving symlinks, any path in a guarded tree
  is 404 whatever the grant, so `ln -s ~/.code-foundry/daemon.token docs/t.txt` inside a
  project does not leak the token. `Grants.Grant`/`GrantFile` also refuse anything the
  floor forbids (`ErrGuarded`), so no caller can mint a home-wide grant by mistake.

**Every Code Foundry home, not only this daemon's (2026-10-25, `bridge-fix-crosshome.md`).**
A test daemon under its own `CODE_FOUNDRY_HOME` runs beside the real one every day, and its
pages must not read the other daemon's token, so the config-home rule above applies to each
home the floor can know: the current one, the default `~/.code-foundry` (always, even when
it is not the current one or does not exist), and any directory holding a `daemon.token` or
`pages.port` (`homeMarkers`). Those last are found when asked, not at start: `Guarded`
stats the markers in the path's ancestors up to home (unresolved, so a link into another
home is found through the link, and again on the resolved path at the route), and
`ScopeOK` also in the tree's direct children, so `~/dev` is no scope beside `~/dev/cf`. Each
home keeps its `worktrees/`, `projects/` and `pages/` open. A home deeper in a tree than its
direct children does not refuse the grant, but every path inside it is 404. The API's CORS
is the other half: it no longer reflects any loopback origin outside dev mode, so a page on
another daemon's pages origin cannot call this one's API even holding its token.

**Identity, not names (2026-10-25, `bridge-fix-floor.md`).** Every rule above is about
files, not spellings. APFS folds names more than any string comparison here does (`~/.ßh`
and `~/.ſsh` open `~/.ssh`, `~/.conﬁg` opens `~/.config`, a home named `cf-test` is also
`cf-teſt`), so the names are only a fast path and file identity decides: `Guarded` stats
the path (symlinks resolved) and each directory above it and compares them with
`os.SameFile` against the guarded roots, stat'd on every call (a config home is open again
below its own `worktrees/`, `projects/` and `pages/`, compared the same way), and `ScopeOK`
refuses a tree that is, by identity, home or above a guarded root. A regular file with more
than one link is also compared against the guarded files (a hard link to `daemon.token` is
the token), up to two levels below each guarded folder, `~/Library` skipped.

## CORS

* `cors` now wraps only the bearer-protected side (`loopbackHandler`) and reflects only
  `wails://localhost` (any port: production and `wails3 dev`) and `http(s)://` pages on
  `localhost`, `127.0.0.1`, `[::1]` (the dev frontend in a browser,
  `?daemon=…&token=…`; since 2026-10-25 only for `daemon --dev` and the origins it lists,
  `bridge-fix-crosshome.md`). Anything else, `null` above all, gets no CORS headers; its
  preflight falls through to the bearer check and is 401, so the browser blocks the call
  even when the page holds the token.
* The preview route sets `Access-Control-Allow-Origin: *` itself, on every response
  including 404s: its pages are opaque-origin and `fetch('data.json')` of their own files
  worked only because `null` was reflected. A grant is already the credential for those
  files, so `*` gives nothing away.
* Checked: the real Wails build connects (`origin":"wails://localhost"` in the daemon's
  debug request log, no 401s); the dev frontend at `http://127.0.0.1:<port>` against the
  real daemon works; the mock daemon (e2e) has its own CORS and is unaffected.

## Not changed

* **Grant lifetime.** Grants still last until the daemon stops (see
  `html-preview-interactive.md` for why: a frame left open must reload). With the floor a
  long-lived grant is a key to one checkout, one non-home folder or one file, never to
  home or the token, which was what made the lifetime dangerous.
* **Symlinks within home** still resolve when they leave the scope (a worktree linking a
  shared assets folder keeps working); only guarded targets are refused. Requiring
  resolved paths to stay inside the scope would be stricter; left as a follow-up if wanted.
* A loose file in a broad but unguarded folder (`~/Downloads/page.html`) still gets that
  folder as its scope, so its page can read the other files there. That is how its
  relative links work; the footer names the folder.

## Gotchas

* Playwright launched with `HOME` pointing at the scratch home cannot find its browsers;
  run the browser checks with the real `HOME` and only the daemon under the fake one.
* `/tmp` is `/private/tmp`: the floor resolves the config home before comparing, and the
  tests resolve their temp dirs.
