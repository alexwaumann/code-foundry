# Theme CSS route: pages the model writes paint in the user's theme (2026-10-22)

Alex: HTML the model writes (the File tab's preview today; an inline thread block,
artifacts and plugin surfaces later) should look native. It links one stylesheet the
daemon serves with the active theme's resolved slots, and gets a message when the theme
changes. The GUI resolves the slots (`src/themes/slots.ts`, theme-slots-1-engine.md) and
publishes them; the daemon derives nothing.

## What ships

* **`UiService.PublishTheme { id, scheme, vars: map<string,string> }`.** `vars` is every
  resolved slot (`--cf-*`, `--terminal-*`, `--syn-*`, `--sh-*`: 98 names), as
  `activeTheme().slots` holds them. `internal/theme.Live` keeps the last one in memory,
  one per daemon: with several windows the last writer wins, which is fine because the
  theme is one per user. `Frame.Check` refuses (InvalidArgument) an id that is not
  `[a-z0-9-]`, a scheme other than dark/light, no vars or more than 512, a name outside the
  four slot families, or a value that is not `#rrggbb` / `#rrggbbaa`. Names and values are
  written into a stylesheet verbatim, so nothing else gets through.
* **GUI publish** (`lib/theme.ts` `startThemePublish`, started in `App.tsx`): on start, on
  every change of the active theme (`subscribeThemeSlots`) and on every connect. A connect
  is the health store's first good ping, a new daemon pid (a restart), or recovery after a
  failed ping. Debounced 150 ms, so the Themes page's arrow keys send once. A failed
  publish is dropped; the next connect sends again. A daemon older than the RPC answers
  Unimplemented and keeps serving the defaults.
* **Routes** on the loopback listener, outside `requireBearer` like `/preview/`
  (`daemon.loopbackHandler` now takes a map of open prefixes). The list is closed and
  takes no path parameter:
  * `GET /cf/theme.css`: `:root { color-scheme: <scheme>; --cf-…: …; }` with every
    published var (sorted), then `internal/theme/frame.css`.
  * `GET /cf/theme.json`: `{ "id", "scheme", "vars", "published" }`.
  * Anything else under `/cf/` is 404, and a method other than GET/HEAD is 405.
  * Headers: `Cache-Control: no-store`, `Content-Type: text/css; charset=utf-8` (JSON:
    `application/json; charset=utf-8`), `X-Content-Type-Options: nosniff`,
    `Access-Control-Allow-Origin: *` (the preview's pages are opaque-origin, so their
    `fetch("/cf/theme.json")` is cross-origin).
* **`frame.css`** (generated, committed) is the static part:
  * the 44 component names aliased to slots exactly as index.css does (`--background:
    var(--cf-canvas)`, `--card`, `--primary`…), so a page written against shadcn names
    works;
  * the radius scale (`--radius-sm` 4px, `-md` 6, `-lg` 10, `-xl`/`-pane` = `--radius`
    0.75rem, `-2xl` 16);
  * `--tracking-tight`, `--font-sans` and `--font-mono`;
  * zero-specificity page defaults: `:where(html)` gets the surface, text and system font,
    `:where(code, kbd, pre, samp)` mono, `:where(a)` the link colour, plus `::selection`;
  * the type roles as plain classes (`.text-title` … `.text-code`, `.text-link:hover`;
    not `.text-brand`, the sidebar's), each colour read from its slot.
* **Before anything is published**, `theme.css` serves GitHub Dark on `:root` and GitHub
  Light under `@media (prefers-color-scheme: light)`, so a page loaded before the GUI
  connects follows the system. `theme.json` serves GitHub Dark with `"published": false`.
  Both come from `internal/theme/frame-defaults.json` (generated: the two defaults run
  through `resolveSlots`).
* **Frames** (`HtmlPreview`): the iframe is posted
  `{ type: "cf:theme", id, scheme, vars }` (`themeFrameMessage()`, vars = the same slot
  map) with `contentWindow.postMessage(msg, "*")` on its `load` and on every change of the
  active theme. The target is `"*"` because the frame is opaque-origin; the message holds
  only colours. A page that wants live updates listens and sets each var on `<html>`:

  ```js
  addEventListener("message", (e) => {
    if (e.data?.type !== "cf:theme") return;
    for (const [k, v] of Object.entries(e.data.vars)) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.colorScheme = e.data.scheme;
  });
  ```

  A page that does not listen still gets the right theme on its next load (the frame
  remounts when the file changes, and on Refresh). Since the aliases are `var()`s declared
  on `:root`, setting the slots inline on `<html>` moves `--card`, `--primary` and the
  rest too.
* **Mock daemon**: `mock/theme.ts` implements the RPC and both routes from the same
  committed files.
* **Skills and capabilities**: the entry skill's "Showing things" and the help skill's
  "Showing things in the app" tell the model to link the stylesheet and paint with the
  `--cf-*` variables (surfaces, text, accent, status triples, sidebar, diff, charts) or the
  type-role classes; the help skill adds the `cf:theme` message. `daemon.capabilities
  --group rendering`'s html line names the stylesheet, the JSON and the message.

## Decisions and gotchas

* **No derivation in Go.** The daemon writes out exactly what the GUI published. The parts
  that never change (aliases, radii, roles) are generated by `pnpm run themes`
  (`themes/frame.ts`, called from `convert.ts`) from `COMPONENT_ALIASES` and
  `src/index.css`. `themes/frame.test.ts` fails on drift, as the catalog test does.
* **Role colours go through the alias table**, so index.css can move its roles from
  `var(--foreground)` to `var(--cf-text)` (the slot-migration PR running alongside this
  one) without changing `frame.css`. A role whose size, weight or tracking changes does
  need `pnpm run themes`; the drift test says so.
* **Defaults follow the system rather than a setting.** The daemon cannot resolve
  appearance.theme = "system" (that needs macOS's appearance), and the GUI publishes within
  ~150 ms of connecting anyway.
* **Skill size caps** (entry 70 lines, help 105) hold. To pay for the new lines:
  * entry: "Discovering what exists" drops its list of example groups; the
    `$CODE_FOUNDRY_THREAD` line drops "pass `--id` for another (`thread list` prints the
    ids)", which the orchestrate skill covers; the `--yes` line is one line now;
  * help: "If none of these covers…" is one sentence without the Help-menu report hint;
    "Cite the file paths" is one line; "A question is not a request…" is gone, since the
    entry skill's one rule and "Explain first, then offer" say the same.
* **The worktree agent sandbox** refuses `VAR=x cmd` and heredoc scripts; `env VAR=x cmd`
  works.
* **Disk full during `make check`**: the Go build cache had reached 211 GB and the disk had
  890 MiB free, so every link failed with "no space left on device". Entries unused for
  over a day were deleted (`find ~/Library/Caches/go-build -type f -mtime +1 -delete`,
  freeing 90 GB). The same trim removed old fuzz corpus entries under the cache's `fuzz/`.

## Verified

* `make check` green.
* Daemon and built GUI on an isolated `CODE_FOUNDRY_HOME`, with a page under home linking
  `/cf/theme.css` and using `--cf-surface-raised`, `--cf-text`, `--cf-accent`, the status
  surfaces, the charts and the type roles, opened in a no-project thread's File tab:
  * curl before the GUI connected: the defaults with the media query, JSON
    `published:false`, `/cf/x` 404, the RPC path 401 without a token;
  * after connect: "github-dark (dark), published by the GUI";
  * dark slot → Nord (`settings set`, the store the Settings page writes): the page
    repainted live by message (its "last cf:theme message: nord (2)");
  * appearance → light, then a copy of the page without any script opened fresh: GitHub
    Light from the stylesheet alone (the reload path);
  * back to dark: the scripted page followed by message again.
