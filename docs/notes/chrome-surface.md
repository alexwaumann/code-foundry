# The Chrome surface (experimental)

A Browser tab in the side panel that shows real sites. The app cannot host Electron, Wails will not
give a window several webviews, and iframes fail on most real sites, so the daemon runs system
Chrome headless, drives it over the DevTools protocol, and the panel draws its frames on a canvas
and forwards input. Off by default behind `experimental.chrome_surface`.

It is an experiment: it should stay easy to change or delete. See "How to remove it".

## Shape

- `internal/store/browser` owns one Chrome per daemon, started on first use. `Chrome` here is always
  the system one, found in `/Applications` then `~/Applications`, never the PATH.
- A surface is a panel's Browser tab, named by the panel's key. Its page is a CDP target. One tab
  per panel. A popup is a second target stacked on it.
- `BrowserService.Watch` is the one stream: state, frames, heartbeats. Input, navigation and answers
  are unary, because the tunnel only carries server streams. The GUI keeps one Input call in flight,
  so events stay in order, and merges moves and wheels behind it.
- Commands exist only while the setting is on (`Registry.Toggle`, `internal/daemon/browser.go`), so
  off they are unknown, not unavailable. Nothing in `internal/command/all` names them.

## Decisions

- **`--remote-debugging-pipe`, never a port.** Works on Chrome 157 here. `lsof` shows no listening
  socket in Chrome's process group.
- **The pipe is also the orphan guarantee.** Chrome exits when fd 3 hits EOF, and only the daemon
  holds the write end, so SIGKILL needs no cleanup. A new daemon that starts while the old Chrome is
  still leaving waits for it (`reapStale`). If it does not go, the store kills that one pid after
  reading its command line back and finding this profile in it. Nothing is ever found by name.
- **`Browser.close` first.** The pipe closing alone takes about 5 s with pages open.
- **A crash stays down until Relaunch.** Restarting a Chrome that crashes on start would loop out of
  sight. An idle stop is different: the next view starts Chrome again and returns to the address.
- **Frames.** A viewer holds one frame; a newer one replaces it and the old one is acked at once. The
  newest is acked only after `stream.Send` returns, so a client that cannot take frames holds Chrome
  back instead of frames piling up. The client also keeps only the newest, one decode at a time, so
  its reader never stalls and `internal/wstunnel`'s window only fills on a page that stopped running.
- **A heartbeat 20 ms after a frame.** WKWebView can hold the end of a large message until more
  bytes arrive (`docs/notes/thread-open-stall.md`), and on a still page the last frame is the one
  that would wait.
- **A screenshot opens every cast.** A screencast only carries changes, so a view of a still page
  would stay blank. Starting a cast during a navigation is refused ("Not attached to an active
  page"), and a second start is refused too ("Screencast is already active"), so each main-frame
  navigation stops and starts it.
- **`view.panel.browser --url` carries the address to the window**, which sends it with its Watch.
  An address for a panel nobody sees starts nothing, and without a window Chrome never starts.
- **The controls are window-only.** `browser.back`, `.forward`, `.reload`, `.relaunch` exist for the
  palette and are refused from anywhere else, like `file.save`. They have no default chords
  (`NoKeybinding`), which keeps them out of the settings schema while they come and go.
- **BrowserService answers browser pages only.** A request needs one Origin that `allowedOrigin`
  accepts: no Origin, the CLI's and the Unix socket's case, is 403. This keeps every client built on
  the API from reaching a logged-in browser. It is no wall against a program that holds the token
  and forges the header. A thread's Claude has that token, so see "What this does not stop".
- **No disguise.** No flag changes what Chrome says it is. A site that refuses it is refused.
- **Chrome gets a small environment** (HOME, USER, PATH, TMPDIR, locale), not the daemon's.
- **Real Keychain, no `--use-mock-keychain`.** Cookies in the profile are encrypted with Chrome's own
  "Chrome Safe Storage" item, the same key the user's Chrome uses. That is one shared key, not shared
  data. The mock would leave a fixed, public key on the sign-ins.

## What each unknown turned out to be

All of it measured on Chrome 157 against pages served from localhost.

- **`<select>`.** Worse than invisible: nothing appears, and on a Mac the arrow keys open the same
  menu, so a select is dead. Fixed for same-process frames: a script in an isolated world
  (`helper.go`) catches the press and the arrow keys and reports the options, the GUI draws the list,
  and the pick sets the value and fires `input` and `change`. Not handled: a select inside a
  cross-origin iframe (out of process, no helper there).
- **Date, colour and similar pickers.** The field takes focus and typing. Its popup is the same
  class of problem as a select and is not drawn.
- **JS dialogs.** Work. An overlay names the origin; alert, confirm, prompt and beforeunload are
  answered. A dialog holds the page, so input is dropped while one is open, and a navigation
  dismisses it first, so a page looping on `alert` can be left. A beforeunload dialog shows our words,
  not the page's.
- **File choosers.** Work. Intercepted, an overlay names the origin, and the host's open panel picks.
  Only in the app's window: without a host (a browser dev session) the overlay says so.
- **Clipboard.** Headless Chrome's clipboard is private and in memory. Measured with an empty Mac
  clipboard: `changeCount` did not move on a copy or on `navigator.clipboard.writeText`, and text
  copied in Chrome pasted back in Chrome. So a page cannot read or write the Mac's clipboard at all,
  and both ways are bridged, only on the user's act:
  - Paste: the window's own paste event gives the text, which goes on Chrome's clipboard, then cmd+v
    runs in the page, so its paste handlers run. A page that is not a secure context gets the text
    typed in instead.
  - Copy: cmd+c runs in the page, the daemon reads Chrome's clipboard by pasting into a scratch page
    of its own (no site gets clipboard permission) and `pbcopy`s it. The window cannot: the reply
    arrives after the key's gesture has ended. Chrome's clipboard is then marked read, so a cmd+c with
    nothing selected does not put an old text over what the Mac has.
  - A page's own Copy button: a strip says "The page copied text" with a Copy button. Checked after
    each click. It never moves by itself.
- **`window.open`, `target=_blank`.** Land in the same surface. Every new tab carries `openerId`,
  `noopener` ones too, so they are all adopted. A popup stays a real popup with its opener, so a
  sign-in popup that reports back should work. Back from its first page closes it, as does
  `window.close()`.
- **Downloads.** Work, with no prompt, to `<home>/browser/downloads`. A strip shows them, with Show
  in Finder. A download from a subframe lands in the folder but shows no strip.
- **Headless detection.** Unchanged, and likely to matter. The user agent says `HeadlessChrome/157`,
  `navigator.webdriver` is `true`, `navigator.userAgentData` brands say Google Chrome. `window.chrome`
  exists and `navigator.plugins` has 5 entries. A site that checks the user agent or `webdriver` will
  refuse this. Google's own sign-in is known to refuse automated browsers; that is from its public
  behaviour, not tested here. No site was tested: real sites are for the user.
- **CPU**, Chrome's whole process group and the daemon, 10 s each, on an Apple Silicon Mac with
  other agents running, the GUI in Playwright's WebKit:

  | Page | Chrome | Daemon | Frames |
  | --- | --- | --- | --- |
  | Still, shown | 0.3% | 0.0% | 0 |
  | Animated, shown (418×690 at 2x) | 61.9% | 2.9% | about 60 fps |
  | Animated, hidden | 14.1% | 0.0% | 0 |
  | Still, hidden | 0.2% | 0.0% | 0 |

  A hidden page keeps running: the cast stops, the page's own work does not, until the idle stop.

Found on the way, also handled so the surface does not sit silently:

- **PDFs.** Headless Chrome paints nothing, so the last frame would stay under the new address. The
  surface says it cannot show PDFs.
- **HTTP Basic auth.** The navigation fails. The surface says it cannot ask for the password.
- **A dead address** shows Chrome's error code. Only for navigations we start: a link in a page
  that fails shows whatever Chrome paints.
- **A lost daemon.** A strip says so while the stream retries.

Known not to work, and silent:

- Notifications and geolocation are denied with no prompt; camera and microphone read `prompt` and
  have no way to ask.
- The right-click menu and `title` tooltips do not exist. The cursor does not change over links.
- Client certificates and Kerberos sign-in are untested, and either could matter on a managed Mac.
- A hidden page's audio keeps playing.

## What this does not stop

A thread's Claude holds the daemon's bearer token. With it, and a forged Origin header, a program
can call BrowserService directly: read frames, send input, navigate. The same program runs as the
user and can read the profile on disk. So "an agent reaches Chrome only through daemon verbs" holds
for the CLI and for anything built on the API, not against an agent that sets out to get around it.
A separate secret for the window would raise the bar and needs host changes, which an experiment
should not make. Agents can also run `settings set experimental.chrome_surface true`.

## Gotchas

- `target.title` from `Target.targetInfoChanged` stays the host; the title comes from
  `Page.getNavigationHistory`.
- The about:blank a page starts on is history: `canBack` leaves it out.
- `Input.dispatchKeyEvent` does nothing for cmd+a or option+left on a Mac unless it names the editing
  command (`keys.go`). Plain arrows and Backspace need none.
- `Page.navigate` to a download answers `net::ERR_ABORTED`, which is no failure.
- `make check` runs the live tests when Chrome is installed. Many Chromes at once starve each other,
  so the cases share one. Chrome's singleton socket does not fit under `t.TempDir` on macOS.
- Never let a test reach `pbcopy`: `Options.SetClipboard` is a stand-in in `live_test.go`.

## How to remove it

New files, all deleted:

```
proto/codefoundry/v1/browser.proto (then make gen, which drops the generated code)
internal/store/browser/
internal/api/browser.go, internal/api/browser_test.go
internal/command/commands_browser.go, internal/command/commands_browser_test.go
internal/daemon/browser.go
gui/frontend/mock/browser.ts
gui/frontend/e2e/browser-surface.spec.ts
gui/frontend/src/api/browser.ts, gui/frontend/src/api/browser.test.ts
gui/frontend/src/components/browser/
gui/frontend/src/lib/browserInput.ts, gui/frontend/src/lib/browserInput.test.ts
gui/frontend/src/stores/browser.ts, gui/frontend/src/stores/browser.test.ts
gui/frontend/src/surfaces/browser.ts, gui/frontend/src/surfaces/browserTarget.ts
docs/notes/chrome-surface.md
```

Every line outside them:

```
docs/ARCHITECTURE.md                         the browser/ row in the layout, the BrowserService bullet
internal/daemon/daemon.go                    the applyBrowserCommands call and its error check;
                                             the api.NewBrowser route
internal/daemon/stores.go                    the import, the browser field, openBrowser, Close
internal/store/settings/schema.go            GroupExperimental; the experimental section on Advanced;
                                             its Groups row; KeyChromeSurface; the field
internal/store/settings/settings.go          Settings.Experimental; the Experimental type
gui/frontend/src/surfaces/registry.ts        the import; browserSurface in the list
gui/frontend/src/stores/threadPanelIntent.ts the import; the panel.browser action
gui/frontend/src/stores/views.ts             the import; the panel.browser case; browserPanelCommand
gui/frontend/src/keys/bindings.ts            the import; the inPalette line; the four present entries
gui/frontend/mock/server.ts                  the import; the service; two /__mock/browser routes;
                                             their two doc lines
gui/frontend/mock/settings.ts                the group, the section, the field
gui/frontend/mock/world.ts                   the import; the commands; the field; the reset
```

A user's `settings.toml` keeps an `[experimental]` table after this: the store sets an unknown key aside
under an "# Ignored:" line, which is harmless. `<home>/browser` stays on disk and holds a profile with sign-ins, so a removal
should delete it or tell the user to.

## On a managed Mac

1. Update to a tip build, in Settings › Updates. Restart the daemon when asked.
2. Run `code-foundry settings set experimental.chrome_surface true`, or turn on Settings › Advanced
   › Experimental › Chrome surface.
3. In a thread, open the side panel, press `+`, then Browser. Or run
   `code-foundry view.panel.browser --url https://example.com`.
4. If the tab says Chrome did not answer over its pipe, a policy is the likely cause: look for
   `RemoteDebuggingAllowed` at `chrome://policy` in your own Chrome. The earlier probe passed with
   a port; the pipe is new there.
5. Check what the policies do to a headless Chrome: forced extensions, forced sign-in, a proxy.
6. Sign in to the sites you care about. Note which refuse and what they say.
7. Quit and reopen: are you still signed in? Session cookies do not survive an idle stop.
8. Try each of these once: a `<select>`, a file upload, a download, cmd+c and cmd+v both ways, a
   page's Copy button, a popup sign-in, typing an accent with a dead key.
9. Turn it off. The tab goes, and `pgrep -f code-foundry/browser/profile` prints nothing.
