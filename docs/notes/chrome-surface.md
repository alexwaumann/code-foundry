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
  reading its command line back and finding this profile in it. Nothing is ever found by name. A
  second process started on a live profile hands nothing over: it exits with status 21 and its
  address goes nowhere (measured, and the first Chrome keeps answering).
- **`Browser.close` first.** The pipe closing alone takes about 5 s with pages open.
- **A crash stays down until Relaunch, and Relaunch opens blank.** Restarting a Chrome that crashes
  on start would loop out of sight, and going back to the page that ended it would end it again. So
  the surface opens on nothing and says which site it stopped on. An idle stop is different: the
  next view starts Chrome again and returns to the address, if the address rule still passes it
  (a `data:` page does not get reopened).
- **A long message ends nothing.** Past 32 MiB a message is read to its NUL and skipped, with its
  first 64 bytes kept to fail the call it answered at once. The daemon holds no more than that and
  gives the buffer back. Events a page makes at will (`Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown`) are dropped before they are parsed.
- **`Runtime.enable` stays.** The finding asked to drop it if nothing needs it. The select helper's
  binding does: measured on Chrome 157, `Runtime.addBinding` without it does nothing, named or not,
  and enabling then disabling removes the binding. So a page's console still crosses the pipe, and
  is skipped as above.
- **What a page asks belongs to its target**, not to the surface: dialog, file chooser, select. A
  viewer sees only what the page on screen asks, under that page's address, and the answer goes to
  that session. A dialog from a page behind its popup is dismissed there at once, as Chrome does for
  a tab in the background: held open it could not be answered, and it would stop the popup too when
  they share a process.
- **The address is what the main frame committed.** `Page.frameNavigated`,
  `Page.navigatedWithinDocument` with the main frame's id, `Page.documentOpened`, and nothing from
  `Target.targetInfoChanged`, which reports where a navigation is headed. An error page shows the
  address that failed, not `chrome-error://`. User names and passwords never reach a viewer, however
  the page got there.
- **The bar is built around the registrable domain.** The daemon reads it (`siteOf`, the public
  suffix list) so the window needs no list. While nobody edits, the bar draws the address over the
  input: the path shrinks away first, then the host clips from its left, so its end stays in view.
  Dialogs and choosers lead with the same domain, then the full origin, wrapped and not clipped.
- **Not secure, Bad certificate.** Every page not on https says Not secure, loopback included: one
  rule, and a dev server loses nothing by it. `Security.visibleSecurityStateChanged` with
  `insecure-broken` says Bad certificate, which stays on a page the user went on to anyway. A blank
  popup counts as not secure, and shows `about:blank`: an opener can write into it.
- **Web APIs that reach for the Mac's own UI are off**, by `--disable-blink-features`: see "Open
  questions from the security review".
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
  copied in Chrome pasted back in Chrome. So a page cannot read or write the Mac's clipboard at all.
  `readText` is refused, and `writeText` needs a recent gesture. Chrome's clipboard has no owner and
  all surfaces share it, so at rest it holds a mark, and whatever else is there just changed. Both
  ways are bridged, only on the user's act:
  - Paste: the window's own paste event gives the text. It goes on Chrome's clipboard through a page
    of our own, cmd+v runs, and the clipboard is marked straight after. So the paste event fires in
    the focused frame and nowhere else, secure context or not, no page's script sees the text on the
    way, and nothing evaluates in a page. The key press activates the focused frame and its
    ancestors, as any key press in an iframe does in any browser; `Input.insertText` measured the same.
  - Copy: the clipboard is marked just before a cmd+c or cmd+x goes to the page, so what is there
    afterwards is what that press changed, on that surface. The daemon reads it by pasting into a
    scratch page of its own (no site gets clipboard permission) and `pbcopy`s it. The window cannot:
    the reply arrives after the key's gesture has ended. A Copy with no such press moves nothing.
  - A page's own Copy button: after each click, text on the clipboard moves to that surface, and a
    strip says "The page copied text" with a Copy button. It never moves by itself.
  - Reads stop at 1 MiB: the scratch field's `maxlength` cuts a paste off, and a text that long is
    dropped, so 70 MB on Chrome's clipboard costs nothing.
- **`window.open`, `target=_blank`.** Land in the same surface. Every new tab carries `openerId`,
  `noopener` ones too, so they are all adopted. A popup stays a real popup with its opener, so a
  sign-in popup that reports back should work. Back from its first page closes it, as does
  `window.close()`.
- **Downloads.** Chrome saves each one under its guid in `<home>/browser/incoming`, where it is
  inert: no name the page chose, nothing Finder shows, swept at each launch. It reaches
  `<home>/browser/downloads`, under a cleaned name that never replaces a file, only on the user's
  word (`downloads.go` has the rule):
  - A click or Enter on the surface lets one download through, for 5 s. One click, one download.
  - With no gesture the surface asks: Allow or Block, five at a time, and more are blocked. The file
    waits in incoming meanwhile, up to 256 MiB, because a download cannot be paused or fetched again.
  - A page nobody can see downloads nothing: no viewer, or behind its popup.
  - 20 files and 4 GiB per surface until the user goes somewhere or reloads. A page navigating
    itself does not reset that.
  - The strip lists every file, scrolling, up to 50, and counts what did not fit.
  - `Page.downloadWillBegin` names the session, so a subframe's download is its page's. A frame
    nested inside a cross-site iframe sends only `Browser.downloadWillBegin`, which nothing can tie
    to a surface: no gesture counts then, and the surface the user touched last asks. With nothing
    on screen it is blocked.
  - Chrome sets `com.apple.quarantine` on the file itself, and the move keeps it.
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
  In the real app window, the same animated page: Chrome 65.8%, daemon 3.9%, and about 34% for
  WKWebView's WebContent process (one `ps` reading). The machine's load average was about 55 from
  other work, so read these as rough.

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

## What was exercised, and how

- Real dev daemon, real Chrome, the GUI in Playwright's WebKit, local pages: click, typing, Enter,
  scroll, resize, reload, select, alert, popup, history, download, chooser overlay, refused addresses,
  Chrome killed and relaunched, the setting off and on. After the security review, on a scratch home
  with a stub for Claude: a timed `prompt` over a composer being typed in, a long host, a bad
  certificate and a download flood.
- The real idle stop: Chrome went at 10 minutes to the second, and reopening the panel started it
  again on the same page.
- Daemons of my own: SIGTERM left nothing in 0.65 to 6 s, SIGKILL in 4.1 s, and a new daemon started
  right after a SIGKILL came up on the same profile with no forced kill. No page URL at info level.
- The real app window (`wails://`, WKWebView), by CLI and window captures only, with no synthetic
  input: the Origin guard takes it, frames are live, and 8 of 8 changes to a still page painted within
  0.9 s. That run found the bug where a second `view.panel.browser --url` did nothing on a showing tab.

Not exercised: input of any kind in the real window, so cmd+v, cmd+c to the Mac's clipboard, dead
keys and IME composition, the host's file picker, and the system clipboard's write through `pbcopy`
(tests use a stand-in). No real site has been opened.

## What a user must know before signing in anywhere

**A thread's Claude can drive this browser.** It holds the daemon's bearer token, and with a forged
Origin header it can call BrowserService directly (`internal/api/browser.go:63`): read frames, send
input, navigate, answer dialogs. The same program runs as the user and can read the profile on disk.
So "an agent reaches Chrome only through daemon verbs" holds for the CLI and for anything built on
the API, not against an agent that sets out to get around it. This is an architectural limit, not a
bug to fix here: a separate secret for the window would raise the bar and needs host changes, which
an experiment should not make. Sign in here only to sites you would let your agents use as you.

Also:

- Agents can also run `settings set experimental.chrome_surface true`, until the setting is marked
  as the user's alone (see below).
- The profile's cookies use the same "Chrome Safe Storage" Keychain item as your own Chrome.
- `HeadlessChrome` is in the user agent, so some sites refuse it, and some act differently.

## The security review

Every finding has a test that fails without its fix (checked by undoing each one), and the
reviewer's pages were replayed against the real store and Chrome.

| # | Finding | What changed | Proved by |
| --- | --- | --- | --- |
| 1 | A timed `prompt` stole the keyboard | No overlay takes focus unless the keyboard is already in its surface; it hands it back as it goes | `BrowserOverlays.test.tsx` for every overlay; `browser-surface.spec.ts` from the composer and the bottom terminal; `steal.html` in the real daemon and GUI: the words stayed in the composer, the page got null |
| 2 | Paste leaked past site isolation | Through a page of our own, then cmd+v in the focused frame; nothing evaluates in a page | `TestAPasteRunsNoScriptInThePage`, `PasteReachesOnlyTheFocusedFrame`; `paste-top.html`: no `TOP-STOLE-PASTE`, the child got the event and the value |
| 3 | The address and origin could mislead | Main-frame check, committed address only, no credentials, registrable domain kept in view, Not secure and Bad certificate | `TestWhatTheAddressShows` and neighbours, `browserAddress.test.ts`, the e2e geometry test, `userinfo.html`, a bad certificate on localhost |
| 4 | Unlimited silent downloads | `downloads.go`, above | The rules in `rules_test.go`, three live cases; `dl.html`: 47 listed, 5 asking, 42 blocked, 0 landed, 170 bytes staged, against 47 files and 76 MB before |
| 5 | Stale text reached the Mac | Paste marks the clipboard read; Copy takes only what its key press changed, per surface | `StaleTextNeverReachesTheMac`, `PasteReachesOnlyTheFocusedFrame` |
| 6 | Any page could kill the browser | Long messages skipped; Relaunch opens blank | `cdp_test.go`, `APageCannotEndTheConnection`, `TestRelaunchAfterACrashDoesNotGoBackToThePage`; `kill70`, `killalert`, `killtitle`, `killclip`: Chrome stayed up |
| 7 | `Go` panicked on a large negative delta | Only -1 and 1 pass | `TestGoTakesOneStepOnly` |
| 8 | Dialog routing | Per target, above | `TestADialogOfAPageBehindAPopupIsDismissedThereAndNeverShown`, a live case; `opener-dialog.html`: nothing over the popup, the opener got null and was not stuck |
| 9 | Closing a tab leaked a viewer | `CloseSurface` counts them out and arms the idle clock. So does a Relaunch nobody watches, found on the way | `TestClosingATabCountsItsViewersOutSoTheIdleStopFires`, `TestARelaunchNobodyWatchesStillStopsWhenIdle` |
| 10 | `CODE_FOUNDRY_CHROME_BIN` in any build | Read only when the version is `dev` | `TestChromeBinIsADevBuildsAlone` |

`Runtime.enable` stays, as said above. `dialog` messages and `document.title` needed no handling:
Chrome cuts them to 10 KB and 4 KB before they reach the pipe, so only the console could ever kill it.

Not done here, on purpose: marking `experimental.chrome_surface` as settable by the user only.
Another PR is adding that, and it had not reached main when this was written. Mark it when it does.

### Open questions from the security review

None of these were run with the API on. Anything that could put a real panel on the Mac's desktop
was reasoned about, not triggered.

- **`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`.** Blocked. They do not go
  through `Page.setInterceptFileChooserDialog`, which covers `<input type=file>`, so a page with a
  gesture could reach a real panel. `--disable-blink-features=FileSystemAccess,FileSystemAccessLocal`
  leaves them undefined, in cross-site iframes too.
- **WebAuthn and passkeys.** Blocked, `WebAuth`: `PublicKeyCredential` is undefined, so a site falls
  back to its password path or refuses. Otherwise Chrome could reach the system's own sheet. A site
  that insists on a passkey cannot be signed in to here.
- **`navigator.share`, `EyeDropper`, Web Serial, USB, HID, Bluetooth, Presentation.** Blocked by the
  same flag, for the same reason: their sheets and choosers cannot be answered through a frame.
- **`window.print`.** Not blocked, not run. Print preview is a dialog inside Chrome's own hidden
  window, so the likely result is a page waiting on something nobody sees, which only harms that
  page: Back, a new address or closing the tab should leave it. A stub in the main world would not
  reach cross-site iframes.
- **External protocol handlers.** Not blocked: there is nothing in the protocol to refuse them with,
  no flag, and `Fetch` never sees them. Run with a scheme nothing handles, nothing happens and the page stays. With a
  real handler it was not run, because it would open a real app. From what is known of Chrome: it
  asks in a dialog in its hidden window, which nobody can answer, so nothing opens; but it does not
  ask for `mailto:`, `news:` and `snews:`, so a page could open the user's mail app with a draft,
  once per gesture. Treat that as a known gap.
- **`<input type=color>`.** Not blocked, not run. On a Mac this may be the system colour panel, a
  real window. Harmless in itself, and needs the user's click. Check it on a test machine.
- **`getDisplayMedia`, `getUserMedia`, notifications, geolocation, payment.** Prompts live in the
  hidden window or are denied, so they stay unanswered, as said above. No OS sheet is expected.
- **Fullscreen, `window.moveTo`.** Not run. They act on the hidden window.

## Gotchas

- `target.title` from `Target.targetInfoChanged` stays the host; the title comes from
  `Page.getNavigationHistory`.
- The about:blank a page starts on is history: `canBack` leaves it out.
- `Input.dispatchKeyEvent` does nothing for cmd+a or option+left on a Mac unless it names the editing
  command (`keys.go`). Plain arrows and Backspace need none.
- `Page.navigate` to a download answers `net::ERR_ABORTED`, which is no failure.
- `make check` runs the live tests when Chrome is installed, and CI skips them: its macOS runner has
  Chrome, and three cases timed out there on the first PR run (a page still loading after 15 s),
  beside an unrelated plugin test. Many Chromes at once starve each other, so the cases share one. Chrome's singleton socket does not fit under `t.TempDir` on macOS.
- Never let a test reach `pbcopy`: `Options.SetClipboard` is a stand-in in `live_test.go`.
- The live tests run Chrome through `liveChrome`: a home of its own, `--use-mock-keychain`, no
  background networking, and a resolver that knows only this machine.
- `document.write` into a new popup cancels its navigation, and the page's address becomes the
  opener's. So the address is right, and that case never reaches where the popup was headed.
- A cross-origin iframe cannot start a download with `a.click()` and no gesture: Chrome refuses it
  itself. A hidden `<iframe src>` to an attachment still can.
- `Browser.downloadWillBegin` arrives after `Page.downloadWillBegin`. If Chrome ever swapped them,
  every download would only ask.
- `Input.dispatchKeyEvent` with `commands` reaches the focused frame, cross-site iframes too.

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
gui/frontend/src/lib/browserAddress.ts, gui/frontend/src/lib/browserAddress.test.ts
gui/frontend/src/stores/browser.ts, gui/frontend/src/stores/browser.test.ts
gui/frontend/src/surfaces/browser.ts, gui/frontend/src/surfaces/browserTarget.ts
docs/notes/chrome-surface.md
```

Every line outside them:

```
docs/ARCHITECTURE.md                         the browser/ row in the layout, the BrowserService bullet
go.mod, go.sum                               golang.org/x/net as a direct requirement (publicsuffix)
internal/daemon/daemon.go                    the applyBrowserCommands call and its error check;
                                             the api.NewBrowser route
internal/daemon/stores.go                    the import, the browser field, openBrowser, Close
internal/store/settings/schema.go            GroupExperimental; the experimental section on Advanced;
                                             its Groups row; KeyChromeSurface; the field
internal/store/settings/settings.go          Settings.Experimental; the Experimental type
gui/frontend/src/surfaces/registry.ts        the import; browserSurface in the list
gui/frontend/src/components/panel/keys.test.ts  the browser row and one "hidden" in the pinned lists
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
8. Try each of these once: a `<select>`, a file upload, a download by a click and one the page
   starts itself, cmd+c and cmd+v both ways, a page's Copy button, a popup sign-in, typing an accent
   with a dead key.
9. Turn it off. The tab goes, and `pgrep -f code-foundry/browser/profile` prints nothing.
