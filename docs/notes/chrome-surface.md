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
  gives the buffer back.
- **No `Runtime.enable`, anywhere.** It sends every console line of a page through the pipe, and
  Chrome serialises and queues them whether or not anyone reads them: one page made Chrome 11.8 GB
  and took a calm surface's input from 3 ms to 9.3 s. The select helper's binding needed it, so the
  helper now only keeps what it saw and the daemon asks after a press (`helper.go`).
  `Page.createIsolatedWorld` with the helper's world name finds the same world, script and all, and
  neither it nor `Runtime.evaluate` needs `Runtime.enable` (measured on Chrome 157).
- **`--log-level=2`.** Dropping `Runtime.enable` was not enough. Headless Chrome writes every console
  line to stderr on its main thread, and a page logs faster than a pipe takes it: with the domain
  gone Chrome still reached 2.8 GB and died of it. A console line is logged at INFO. A probe with
  stderr on `/dev/null` hides all of this, which is how it was found: only the real store showed it.
- **What a page sends through the pipe is budgeted, and a page that overspends is closed.** Chrome
  throttles none of it and no event can be refused. `Page.enable` alone lets a page make 6,000 iframes
  a second, each several events, or push 2 MB addresses, and Chrome's main thread falls behind and
  every surface waits: 96 pushes made 5.7 GB and a calm input took 4.6 s, with no `Page` handler of
  ours doing anything. Reading less does not help, because the cost is Chrome's. So `pacing.go` gives
  each page 8 MiB, earned back at 1 MiB a second, an event costing its size plus 1 KiB, its iframes
  charged to it, and a subframe leaving for another site 192 KiB, because that is a process. Past that
  the page gets `Target.closeTarget`, and the surface says which site went. A page loading costs a
  few hundred KB, but a page with over 40 frames on other sites at once is closed as a flood.
- **A popup's address is read from its document.** In the helper's world, `location.href` and
  `self.origin`, which no script of the page's reaches. `Page.getFrameTree` said the same with every
  frame's address in it, and a popup with 20 frames of 2 MB addresses made the reply past the pipe's
  limit: the call failed and the bar stayed empty. A read that fails now leaves the address empty,
  which the bar shows as `Unknown site`, Not secure. `Page.getFrameTree` is left in one place: finding
  which frame holds a select the user pressed, where a page that makes it fail keeps only its own
  select shut.
- **A page that has not painted yet is covered.** A commit to another origin (or to none), and a page
  coming on screen (a popup, or the opener after it), drop the last frame and set `awaiting_frame`
  until this page's first frame. The window blanks its canvas and drops a frame still decoding; a
  screenshot asked for before the commit is not used after it.
- **A popup that cannot be set up is closed.** Half set up, it ran out of sight and stayed tracked.
- **What an event needs done goes on the target's queue.** One goroutine per target, at least 100 ms
  between rounds, and asking twice is asking once. `document.open()` in a loop made 74,000 goroutines
  in 15 s when each event started its own. Reading a history of 2 MB addresses is 100 MB, so that
  read is held to a tenth of the time.
- **Chrome is watched from outside.** `--js-flags=--max-old-space-size=2048` ends a page past that
  heap, but typed arrays are outside it (4.7 GB in a second), and a page logging in a loop sends no
  event at all: its console queues in its own process or in Chrome's, whichever is behind, and
  Chrome's main thread has no time for anyone. So once a second `watchMemory` reads `ps` for Chrome's
  process group. A helper past 4 GiB, or past 1 GiB and up by 512 MiB in 5 s, is killed, which Chrome
  reports as a crashed page. Chrome past 6 GiB, or the group past 12 GiB, goes too, and every
  surface says so. Only that process group: nothing is found by name.
- **A strain on Chrome's own process is blamed on a page at work, never on a busy one.** Until round 3,
  when Chrome's own process swelled by 512 MiB in 5 s, or stayed past 150% CPU for 3 s, the busiest
  helper went. A page pushing history with 64 MB states swells it, and the busiest helper was then an
  animated neighbour with a worker, killed in four runs of four. Now:
  - A swell is first the store's to blame (`blameHistory`): each history entry keeps its state in
    Chrome's own process, 50 entries a page, so the page that pushed most in the last 5 s is closed,
    as a flood. Closing the page gives the memory back; killing its renderer gives none back
    (measured: Chrome's own process stayed at 1,028 MB after the renderer was killed, and went from
    1,646 MB to 700 MB when the page was closed). Past 2 GiB a growth of 64 MiB in 5 s counts too, so
    a page pushing slowly is caught; that path is unit tested and was not seen acting.
  - Otherwise, for a swell or for the CPU, only a helper that is itself past 150% CPU or up by 256 MiB
    in 5 s is blamed, the busiest of them. A console flood's renderer is one. A page that is busy and
    the same size is not, however busy.
  - Nothing to blame, nothing is killed, and the limits on Chrome and the group stay the last line.

  This is still a heuristic: a page that pushes history while something else swells Chrome is
  closed, and a real page growing 256 MiB in 5 s while Chrome strains is killed and says "This page
  crashed".
- **What a page asks belongs to its target**, not to the surface: dialog, file chooser, select. A
  viewer sees only what the page on screen asks, under that page's address, and the answer goes to
  that session. A dialog from a page behind its popup is dismissed there at once, as Chrome does for
  a tab in the background: held open it could not be answered, and it would stop the popup too when
  they share a process.
- **The address is what the main frame committed.** `Page.frameNavigated`,
  `Page.navigatedWithinDocument` with the main frame's id, `Page.documentOpened`, and nothing from
  `Target.targetInfoChanged`, which reports where a navigation is headed. An error page shows the
  address that failed, not `chrome-error://`. User names and passwords never reach a viewer, however
  the page got there. A read of a popup's address that a commit overtakes is dropped: `commits`
  counts them.
- **Who a page is comes from Chrome, not from its address.** `securityOrigin` on the commit, which
  `history.pushState` cannot change. `url.Parse` and `new URL` both refuse what Chrome accepts, so one
  `pushState` to `/%zz`, or a host with `{` or a backtick, blanked the domain and the dialog's
  origin. Nothing here parses an address with a library now: `authority` reads it by hand when
  Chrome has not said yet. One trap: Chrome's `securityOrigin` is `://` for an `about:blank` that
  inherited a real origin, in the event and in `Page.getFrameTree` (measured). So a page with no
  origin is asked `self.origin` in the helper's world, where its script cannot redefine it, and
  until it answers the bar says `Unknown site`.
- **The bar is built around the registrable domain.** The daemon reads it (`siteOf`, the public
  suffix list) so the window needs no list. While nobody edits, the bar draws the origin and address
  over the input: the path shrinks away first, then the host clips from its left, so its end stays
  in view. Every page has a site in the bar, or `Unknown site` where nothing can say (a `data:` page,
  a sandbox, a page whose address could not be read). Until round 3 a page with no address got an
  empty bar and no mark. An address the origin does not lead (`about:blank`, `blob:`) follows it. Dialogs and choosers lead with the same domain, then the full origin, wrapped and not clipped;
  with nothing to name they say "An unknown site", never a blank.
- **Not secure, Bad certificate.** Every page not on https says Not secure, loopback included: one
  rule, and a dev server loses nothing by it. `Security.visibleSecurityStateChanged` with
  `insecure-broken` says Bad certificate, which stays on a page the user went on to anyway. The
  blank a surface's own page starts on, before it has been anywhere, is no page: no address, no
  mark. Every other page with a blank or empty address is Not secure: a popup's blank, whether or
  not its opener is still there (the rule asks whether the page is a popup, not how many pages the
  surface holds, which an opener closed for flooding made one), a page sent to about:blank, and a
  page whose address nothing could read. Until round 3 the rule counted the stack.
- **Web APIs that reach for the Mac's own UI are off**, by flags, profile prefs and session calls:
  see "What reaches the Mac's own UI". The prefs go into `<profile>/Default/Preferences` before each
  launch (`hardenProfile`), merged over what is there.
- **Every cross-site iframe has a session of its own.** `Page.setInterceptFileChooserDialog`, the
  helper and a download's session stop at the process boundary, so a file input in such a frame had
  no interception. `Target.setAutoAttach` on each session, nested ones too, holds a new frame paused
  until it has the same set-up (`frames.go`). A frame whose set-up fails stays paused, and so does
  one past 32 per page. `filter` keeps it to iframes, and workers are not attached. It does not
  attach popups, whichever filter is used (measured): those still come by `Target.targetCreated`.
  When a page navigates, Chrome reports its frames going but not a frame inside one of them, so each
  visit to a page with a nested cross-site frame left one counted, and after about 31 visits no new
  cross-site frame ran. A frame now goes with the frame it was attached on, and a main-frame commit
  clears the page's count. On real Chrome either alone fixes the visits; each has a test of its own.
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
- **To a page shown in the app** (`docs/notes/page-verb-gate.md`): `view.panel.browser --url` aims a
  browser that may be signed in as the user, so it asks first (`PageAsks` on `url`); showing the tab
  alone does not. The controls are `PageRuns`, so they ask too and are then refused: that fails closed.
- **The setting is the user's alone** (`UserOnly`, `docs/notes/settings-user-only.md`): a page, a
  plugin and a thread's CLI are refused, confirmed or not. The user turns it on in Settings, or with
  the CLI from a terminal that is not a thread's.
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
  menu, so a select is dead. Fixed: a script in an isolated world (`helper.go`) catches the press
  and the arrow keys and keeps the options, the daemon reads them after that press, the GUI draws the
  list, and the pick sets the value and fires `input` and `change`. Cross-site iframes have the
  helper too, through their own session, and the list opens where the user pressed, because the
  frame only knows where it sits in itself. One press reads at most 32 frames.
- **Date, colour and similar pickers.** The field takes focus and typing. Its popup is the same
  class of problem as a select and is not drawn.
- **JS dialogs.** Work. An overlay names the origin; alert, confirm, prompt and beforeunload are
  answered. A dialog holds the page, so input is dropped while one is open, and a navigation
  dismisses it first, so a page looping on `alert` can be left. A beforeunload dialog shows our words,
  not the page's.
- **File choosers.** Work. Intercepted, an overlay names the origin, and the host's open panel picks.
  Only in the app's window: without a host (a browser dev session) the overlay says so. In a
  cross-site iframe the interception is on the frame's session, and the overlay names the frame, not
  the page. That was proved by inspecting the sessions, and no file input in a frame was ever
  clicked: a mistake there would open a real panel.
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
    strip says "The page copied text" with a Copy button. It never moves by itself, and it goes when
    the page does. Only the surface's latest click reads: these wait on the clipboard's lock, and
    one that went late took the next click's text.
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
  - A click, or Enter on a link, lets one download through, for 5 s, on the page it was made on.
    One click, one download. Space and typing are no gesture: they come with every word, and a page
    can have been waiting for any key. Enter on a button is none either, nor Enter inside a
    cross-site iframe, where the helper in the page cannot see a link: those ask.
  - With no gesture the surface asks: Allow or Block, five at a time, and more are blocked. The file
    waits in incoming meanwhile, up to 256 MiB, because a download cannot be paused or fetched again.
  - A page nobody can see downloads nothing and asks nobody: no viewer, or behind its popup.
  - 20 files and 4 GiB per surface until the user goes somewhere or reloads. A page navigating
    itself does not reset that.
  - The strip lists every file, scrolling, up to 50, and counts what did not fit.
  - `Page.downloadWillBegin` names the session, so a subframe's download is its page's. Every
    cross-site iframe has a session now, nested ones too, so its download is its own page's as well,
    in the frame's name. No gesture counts for it: the click was on the page, not on what a third
    party embedded there, so the surface asks. A hidden page's frame asks nobody. A download nothing
    can place is blocked, and no surface is told.
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

- **PDFs.** Download, under the rule for any download: a click lets one through, anything else asks.
  Until round 3 this note said headless Chrome paints nothing for a PDF; that was false. Chrome's
  viewer showed it, with Download and Print buttons of its own, and the surface's notice said it
  could not. Those buttons were not clicked. Now `plugins.always_open_pdf_externally` is set, so the
  viewer never opens: on real Chrome, a typed PDF address asks, a click on a link to one lands in
  the downloads folder, and an embedded one shows Chrome's placeholder with an Open button, which
  was not clicked. `download.open_pdf_in_system_reader` is off and `download.extensions_to_open` empty,
  so nothing downloaded is opened; after the downloads above no Preview process was running. A PDF
  that commits anyway is left for about:blank.
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
- After the second review, a scratch dev daemon with the GUI in WebKit and a stub for Claude, checking
  where the keyboard was before every key: Enter on an address with a server holding its first byte,
  `/%zz` with a dialog, a popup rewriting its opener, a timed prompt over the address bar.
- After the third, the same: a second address typed while the first was held, typing over a page
  pushing its address every 50 ms, the popup with a 40 MB frame tree, and a lure to a slow first
  paint. Every key was sent only after reading where the keyboard was.
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

- Agents cannot turn it on: the setting is the user's alone. Once it is on, they can still drive the
  browser as above.
- Sign-ins stay on disk after the setting is off, in `<home>/browser/profile`. Deleting
  `<home>/browser` (`~/.code-foundry/browser`) removes them, and the setting's description says so.
- The profile's cookies use the same "Chrome Safe Storage" Keychain item as your own Chrome.
- `HeadlessChrome` is in the user agent, so some sites refuse it, and some act differently.

## The security review

Three rounds. Round 1's table claimed more than it had proved: a re-check broke several rows with
real pages, so those rows now say what stands. Round 2 is what came of that, and round 3 broke four
of its rows (below). In each, every fix has a test that fails without it, checked by undoing the fix
(round 2: 36 changes undone one at a time, and every one failed a test). All pages were local and
every Chrome was headless on a mock keychain.

### Round 1, and what stands

| # | Finding | State now | Proved by |
| --- | --- | --- | --- |
| 1 | A timed `prompt` stole the keyboard | Holds. Round 2 closed two ways round it: the address bar, and a slow server | `BrowserOverlays.test.tsx`; `browser-surface.spec.ts`; `steal.html` in the real daemon and GUI |
| 2 | Paste leaked past site isolation | Holds, with the limit under "Accepted for now" | `TestAPasteRunsNoScriptInThePage`, `PasteReachesOnlyTheFocusedFrame`; `paste-top.html` |
| 3 | The address and origin could mislead | Was not done: `/%zz` and a host with `{` broke it. Round 2 items 3 and 4 | Below |
| 4 | Unlimited silent downloads | Was too loose: typing counted as a gesture, a gesture outlived its page, and "a hidden page gets nothing" was false for a page whose download no session reported. Round 2 items 7, 9 and 11 | `dl.html` as before, and below |
| 5 | Stale text reached the Mac | Holds for what it tested. A notice that ran late could take the next click's text, found in round 2. See "Accepted for now" for the one known race | `StaleTextNeverReachesTheMac`, `PasteReachesOnlyTheFocusedFrame` |
| 6 | Any page could kill the browser | Round 1 stopped one way (a single huge message), and said "only the console could ever kill it", which was false: `pushState` did, and floods froze every surface. Round 2 item 1 | `cdp_test.go`, `APageCannotEndTheConnection`, `TestRelaunchAfterACrashDoesNotGoBackToThePage`, and below |
| 7 | `Go` panicked on a large negative delta | Holds | `TestGoTakesOneStepOnly` |
| 8 | Dialog routing | Holds. The test behind it flaked on a real race, round 2 item 12 | `TestADialogOfAPageBehindAPopupIsDismissedThereAndNeverShown`, 100 runs of 100 |
| 9 | Closing a tab leaked a viewer | Holds | `TestClosingATabCountsItsViewersOutSoTheIdleStopFires`, `TestARelaunchNobodyWatchesStillStopsWhenIdle` |
| 10 | `CODE_FOUNDRY_CHROME_BIN` in any build | Holds | `TestChromeBinIsADevBuildsAlone` |

### Round 2

| # | Finding | What changed | Proved by |
| --- | --- | --- | --- |
| 1 | Any page, no gesture, could freeze every surface and grow Chrome past 10 GB | No `Runtime.enable`, `--log-level=2`, the event budget, the heap cap, the outside watch | `TestNoSessionHandsItsConsoleToThePipe`, `TestAPageThatFloodsThePipeIsClosedAndNoOtherIs`, `TestWhatTheMemoryWatchKills`, `AFloodClosesThePageAndNoOther`; the floods below |
| 2 | A slow server pulled the keyboard out of the composer | The page gets it only if it is still in the toolbar. No other async path moves focus into the surface: `useReturnFocus` and `pageFocus` run on mount and unmount and check first | `BrowserToolbar.test.tsx`. Real daemon and GUI: Enter on an address held 5 s, on to the composer, "my secret words more" stayed there, the page's server logged no key |
| 3 | `/%zz` hid the domain and blanked the dialog's origin | Origin from Chrome, no URL library anywhere near it, `Unknown site` and "An unknown site" where nothing can say | `TestWhoAPageIsSurvivesWhatAParserRefuses`, `TestTheAddressReadsChromesOriginAndNotTheAddress`, `browserAddress.test.ts`, `TheSiteSurvivesAnAddressNoParserTakes`. Real GUI: bar `evil.test:18598`, dialog `evil.test says` |
| 4 | A popup rewrote the page behind it under an empty bar | An `about:blank` that is not the first shows the origin it inherited and Not secure | `TestABlankPageShowsTheOriginItInheritedAndIsNotSecure`, `APopupCannotBlankItsOpenerUnnoticed`. Real GUI: `evil.test:18598 about:blank`, Not secure, over the fake sign-in |
| 5 | `document.open()` grew goroutines without limit | One goroutine per target, paced; a page keeping it up is closed by the budget | `TestDocumentOpenInALoopStartsOneGoroutine`; the floods below |
| 6 | WebAuthn was not blocked | `WebAuthn.enable` on every session, with no authenticator: see below | `WebAuthnReachesNothingReal`, `TestEveryIframeIsInterceptedBeforeItRuns` |
| 7 | A file input in a cross-site iframe had no interception | `Target.setAutoAttach`, a session and the full set-up per frame before it runs | `TestEveryIframeIsInterceptedBeforeItRuns`, `TestAnIframeWhoseSetUpFailedStaysPaused`, `EveryCrossSiteFrameHasASessionOfItsOwn`: nested frames each on a session that reaches their document. No file input in a frame was clicked |
| 8 | A timed prompt stole the address bar | The gate is the page, and the toolbar is outside it | `BrowserOverlays.test.tsx`. Real GUI: the prompt came up, the keyboard stayed in the bar, its answer stayed empty |
| 9 | The download gesture was too loose | Only a click, or Enter on a link. A navigation clears it | `TestWhatCountsAsAGesture`, `TypingIsNoGestureAndNeitherIsSpace`, `AGestureDoesNotSurviveTheNextPage` |
| 10 | A page's copied text outlived it | Cleared on the page's commit, and a read that crosses one is dropped | `APagesCopyDoesNotOutliveThePage`, `BrowserOverlays.test.tsx` |
| 11 | A hidden page could ask on a visible surface | A download belongs to its page's surface, and what nothing places asks nobody | `TestAHiddenPagesIframeAsksNobody`, `TestADownloadNothingCanPlaceAsksNobody`, `ACrossSiteFrameCanOnlyAsk` |
| 12 | A stale `readAddress` overwrote a newer commit | `commits`: an answer a commit overtook says nothing | `TestAStaleReadOfAPopupNeverReplacesItsCommit`; `TestADialogOfAPageBehindAPopup…` with `-count=100` |

The floods, each on a new Chrome with a calm surface on another site beside the flooding one, input
sent to the calm one 4 times a second for 8 s. Baseline input 2 to 20 ms. The harness kills Chrome at
6 GB; it never had to.

| Flood | Worst calm input | Chrome's group at peak, MB | What ended it |
| --- | --- | --- | --- |
| `console.log` in a loop, tiny | 0.64 s | 1,817 | Killed by the watch at about 3 s |
| The same, 200 byte lines | 0.89 s | 2,565 | The watch |
| The same, on a tab out of view (`MessageChannel`) | 0.57 s | 2,170 | The watch |
| The same, from a worker | 64 ms | 1,143 | Still running, harmless |
| `console.log` of 1 MB, and of 31 MB | 18 ms, 73 ms | 1,155, 1,387 | Still running, harmless |
| `throw` of 5 MB | 18 ms | 3,319 | The heap cap or the watch |
| `document.title` of 1 MB | 6 ms | 2,284 | The watch |
| Heap | 2 ms | 2,509 | The heap cap |
| Typed arrays | 1 ms | 5,180 | The watch |
| Canvases of 4000×4000 | **2.3 s** | 1,169 | Still running after 15 s: nothing sees this one |
| `fetch` of 404s | 6 ms | 2,331 | The watch |
| Same-process iframes in a loop | 3 ms | 1,702 | Closed by the budget |
| `document.open()` in a loop | 6 ms | 1,170 | The budget; goroutines peaked at 20, against 74,000 |
| `location.hash` in a loop | 73 ms | 1,244 | Chrome's own limit of 200 in 10 s |
| `pushState` of 2 MB, every 20 ms | 2.5 s | 2,232 | The budget |
| The same, as fast as it will go | 1.3 s | 2,443 | The budget |
| The same, on a tab out of view | 2.4 s, three runs of three | 2,411 | The budget |
| `pushState` of 2 MB every 2.5 s | 138 ms | 1,336 | Still running, under the budget |
| Frames to 40 new sites a second | 74 to 210 ms | 4,058 to 5,931 | The budget; Chrome back to 1.2 GB about 9 s after the close |
| Frames to new sites, 20 per tick | **2.1 s** | **past 6,268** | **Not proved.** See below |

The daemon's goroutines stayed under 30 in all of these but the frame floods, where they reached 82.
Each run left Chrome answering and the calm surface at 1 ms, except the last.

Three that are not good enough, and stay open:

- **Frames to new sites as fast as a page can.** Each is a renderer, and Chrome spawns about 40 a
  second. The budget closes the page in about 0.7 s, but Chrome's main thread is behind by then, the
  close takes over 2 s to land, and meanwhile renderers keep starting. The harness stops any Chrome at
  6 GB of summed RSS, and every run got there first, so the end of this flood was not seen.
  `--renderer-process-limit` does not hold (measured: 73 with a limit of 24), because a renderer
  cannot be shared across sites. The last line is `maxGroupRSS` at 12 GiB, which kills all of Chrome:
  its unit test passes, it was not seen acting. Before the budget and that limit, one run went to
  26 GB of summed RSS, because the harness's check sat behind a blocked call. That has a watcher of
  its own now. Summed RSS counts shared pages once per process, so it overstates real memory.
- **Canvases.** A calm input waits up to 2.3 s, on the GPU process, for as long as the page goes on.
  Nothing grows enough for the watch and no event says so.
- **`pushState` of 2 MB.** A calm input waits 1.3 to 2.5 s for the second or so before the page is
  closed. One run reached 9.5 s, with the Mac's load at 23 from other work and the baseline itself
  at 200 ms, and three repeats gave 2.4 s.

Before round 2, on the same machine: the console flood took a calm input from 3 ms to 9.3 s with
Chrome at 11.8 GB, `Navigate` timed out at 25 s, and `pushState` killed Chrome.

Round 3 broke four rows of round 2: 1 (the watch's busiest helper was a busy neighbour), 2 (the
keyboard check missed a second address typed in the bar), 4 (an empty bar had no mark) and 7 (frames
inside frames were left counted).

### Round 3

| # | Finding | What changed | Proved by |
| --- | --- | --- | --- |
| 1 | A slow server pulled the keyboard out of the address bar: a second address went to the page key by key, and the answer wiped it | The keyboard goes to the page only if the bar still holds exactly what was sent; a newer draft stays, and keeps the keyboard | `BrowserToolbar.test.tsx`. Real GUI: every key of a second address stayed in the bar and the page's server logged none (the review's run leaked `/reset?token=SECRET-TOKEN-VALUE`) |
| 2 | A page's `pushState` dropped the address being typed, and Enter sent the rest to the page | The draft stays while the bar has the keyboard, whatever the page's address does; away from the bar, the page moving on drops it | `BrowserToolbar.test.tsx`. Real GUI: a page pushing every 50 ms, the whole address went with Enter and nothing reached the page's server |
| 3 | A fake sign-in under an empty bar, no site and no mark: `Page.getFrameTree` past the pipe's limit, or a popup left alone when its opener was closed | A popup's address is read from its document in the helper's world; an empty address is `Unknown site`, Not secure; the blank rule asks whether the page is a popup | `TestAPopupNobodyCouldReadSaysSoAndIsNotSecure`, `TestAPopupWhoseOpenerWentIsStillAPopup`, `BrowserToolbar.test.tsx`, `APopupWithAHugeFrameTreeIsNamedAndMarked`. Replays: the 40 MB tree reads `evil.test about:blank`, Not secure, in the real GUI; the orphaned popup is Not secure (was no mark) |
| 4 | A history flood got a busy neighbour killed | A swell of Chrome's own process closes the page that pushed history; otherwise only a helper that is itself hot or growing is blamed | `TestWhatTheMemoryWatchKills`, `TestTheStoreIsAskedAboutASwellFirst`, `TestASwellIsBlamedOnThePageThatPushedHistory`, `AStateFloodClosesThePusherAndNoNeighbour`; the review's own flood, four runs, below |
| 5 | Frames inside frames were left counted: after about 31 visits, no new cross-site frame ran | A frame goes with the frame it sits in, and a main-frame commit clears the page's count | `TestFramesInsideAFrameGoWithIt`, `TestANewDocumentStartsWithNoFramesCounted`, `FramesInsideFramesAreNotLeftCounted`. Replay: 36 visits, 2 frames counted on each and every one ran (was one more per visit, to 32) |
| 6 | An old page's last frame stayed under a new address | `awaiting_frame` until the page's own first frame; the old frame is dropped, and the window blanks its canvas | `TestACommitToAnotherSiteCoversTheLastFrame`, `TestAScreenshotAcrossACommitIsNotTheNewPages`, `useBrowserStream.test.ts`, the e2e "a page that has not painted yet", `ACommitToAnotherSiteIsCoveredUntilItPaints`. Real GUI: 1.29 M red pixels under the lure's address, none from the bank's commit until it painted |
| 7 | A popup that failed its set-up stayed hidden and tracked | Closed | `TestAPopupThatCannotBeSetUpIsClosed`. Replay: an opener held the popup's renderer for 12 s, `Page.enable` timed out, and the popup was closed and gone from Chrome's targets (with the fix undone: still there, tracked, never shown) |
| 8 | PDFs: the note said nothing renders, and Chrome's viewer showed them with Download and Print | PDFs download (see PDFs above) | `TestTheProfileRefusesWhatLeavesTheWeb`, `TestAPDFThatShowsAnywayIsLeft`, `APDFIsADownload` |

Also: the setting is `UserOnly`, and the browser verbs have page classes (`page_class_test.go`,
`TestAPageAimingTheBrowserAsksTheUser`). `endpoint.test.ts` finds `BrowserService/Watch` and passes.
Found on the way: a page closed behind its popup left the surface saying "popup" until something
else published; it says so at once now (`TestAPopupWhoseOpenerWentIsStillAPopup`).

Each fix was undone one at a time: 16 changes in Go and 5 in the window, and each failed a test. On
real Chrome, 5 of 7 failed a live case. The two that did not: the old busiest-helper rule, because
the history blame acts first on that flood (the table test holds the rule); and dropping a frame's
children alone, because a main-frame commit also clears the count (each has a fake test, and
undoing both fails the live case).

The floods of round 3, each on a new Chrome, with a still page and a busy one (an animation and a
worker that never rests) beside the flooding page. Input to the still page 4 times a second.

| Flood | Worst still input | Chrome's group at peak, MB | Chrome's own at peak, MB | What ended it |
| --- | --- | --- | --- | --- |
| `pushState` with a 64 MB state, the review's page, four runs | 76 to 637 ms (one sample each; the rest 1 to 160 ms) | 1,824 to 2,854 | 646 to 1,272, then 446 to 704 | The history blame closed the page after 3 to 11 pushes. The busy neighbour was untouched in 4 of 4 (the review: killed in 4 of 4) |
| `console.log` in a loop, tiny | 713 ms | 2,016 | 595 | The watch, on the page's renderer |
| The same, 200 byte lines | 269 ms | 1,842 | 528 | The watch |
| `document.title` of 1 MB | 1 ms | 2,215 | 263 | The watch |
| `fetch` of 404s | 8 ms | 2,569 | 375 | The watch |
| Typed arrays, 512 MB every 50 ms | 1 ms | 3,728 | 261 | The watch |

None of these touched the busy neighbour. The `pushState` flood of 2 MB addresses and the frame
floods are the event budget's, which round 3 did not change.

### Accepted for now

- A page writing Chrome's clipboard in a hard loop can land its text between our mark and a cmd+c on
  another surface: 2 of 872 presses in the review.
- A key press in an iframe activates its top page, as the HTML spec says, so a paste there hands the
  top page the activation any key would.
- A flood of console lines costs a calm surface up to about a second of input lag for the 3 s or so
  before the watch acts. It sends no event to act on sooner, and no flag stops it.
- A page can fill memory until the watch sees it: about a second, at up to 4 GB a second.
- A page pushing history slowly, under 512 MiB in 5 s, grows Chrome's own process until it is past
  2 GiB; only then is it closed. That path is unit tested and was not seen acting: a run long enough
  to reach it is past the 20 s every flood here was held to. Chrome keeps 50 entries a page.
- A page that pushes history while something else swells Chrome is closed for it.
- An address typed in the bar that turns out to be a download (a PDF, say) asks, under the page's
  name: typing is no gesture.
- Pages sharing a site share a renderer, so the watch killing one kills the others on that site.
- A popup runs for a moment before its session is set up, because `Target.setAutoAttach` does not
  reach popups. Its file input and WebAuthn need its own user activation, which it cannot have yet.


### What reaches the Mac's own UI

Nothing here was triggered with the block off. Anything that could put a real panel on the desktop
was not run.

- **`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`.** Blocked. They do not go
  through `Page.setInterceptFileChooserDialog`, which covers `<input type=file>`, so a page with a
  gesture could reach a real panel. `--disable-blink-features=FileSystemAccess,FileSystemAccessLocal`
  leaves them undefined, in cross-site iframes too (read, not called).
- **WebAuthn and passkeys.** `--disable-blink-features=WebAuth` only hides `PublicKeyCredential`:
  `navigator.credentials.create` still worked. What blocks it is `WebAuthn.enable` on every session,
  with no authenticator added: a call goes to that empty virtual environment, reaches neither a real
  key nor the system's sheet, and fails with `NotAllowedError` on its own timeout (run, on a session
  first shown to be inside the environment). So a passkey cannot be used here, and a site that
  insists on one cannot be signed in to. `navigator.credentials` itself stays: no flag removes it.
- **`navigator.share`, `EyeDropper`, Web Serial, USB, HID, Bluetooth, Presentation, FedCM.** Blocked
  by the same flag, for the same reason: their sheets and choosers cannot be answered through a frame.
- **Picture-in-picture.** Blocked. `DocumentPictureInPictureAPI` is off, and
  `--blink-settings=pictureInPictureEnabled=false` makes `document.pictureInPictureEnabled` false.
  Read, not called.
- **`window.print`.** The `printing.enabled` pref is false in the profile, and read back as false
  from `chrome://prefs-internals` in a scratch run. The call itself was not made, so what it does
  with the pref off is what Chrome says the pref does: nothing.
- **External protocol handlers, `mailto:` included.** Blocked by `policy.url_blocklist` `*` with an
  allow list of `http`, `https`, `about`, `blob` and `data`, set as a profile pref. A scheme nothing
  on this Mac handles answers `net::ERR_BLOCKED_BY_ADMINISTRATOR` (run), and `blob:` and `data:`
  frames still load (run). `mailto:` itself was not tried, since it would open the mail app. It goes
  the same way as any scheme, so this is reasoned from that and not proved.
- **`<input type=color>`.** A real click is cancelled by the helper, in every frame it reaches, so no
  panel opens from a click, Space or Enter. Proved by an untrusted event, which opens nothing either
  way, coming back cancelled; a real click was not made. Not blocked: `input.showPicker()` from a
  page's own click handler. On a Mac that may show the system colour panel, a real window, harmless in
  itself, and it needs the user's click on the page. No flag removes `showPicker`.
- **Digital credentials.** `DigitalCredential` stays defined, no flag removes it. It needs a gesture,
  and any prompt would be in Chrome's hidden window. Not run.
- **`getDisplayMedia`, `getUserMedia`, notifications, geolocation, payment.** Prompts live in the
  hidden window or are denied, so they stay unanswered, as said above. No OS sheet is expected. Not
  run.
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
- `securityOrigin` is `://` for an `about:blank` with an inherited origin, while the page's
  `self.origin` is right. See the decision on origins.
- When a page navigates, Chrome reports each cross-site frame going, but not a frame inside one of
  them. Removing a frame reports both (measured).
- Killing a renderer gives back none of a page's history state: it is in Chrome's own process.
- The fake Chrome answers one call at a time, so a test reply that waits holds every other call.
- A probe of Chrome with stderr on `/dev/null` shows a console flood as harmless, and `calm` timings
  taken in the same breath as a `ps` are about 90 ms too long. Measure on the real store.
- A page in a background tab has its timers held to one a second, so a flood there looks slow. A
  `MessageChannel` loop is not held, and `Emulation.setFocusEmulationEnabled` lifts the limit.
- Our scratch page taking keys can make a focused iframe see another `focus` event. The keyboard
  stays there: typing after a paste reaches the same field.

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
                                             its Groups row; KeyChromeSurface; the field; "or puts a
                                             signed-in browser within reach" in UserOnly's comment
internal/store/settings/schema_test.go       KeyChromeSurface in TestUserOnlyFields, and its comment
internal/command/commands_settings_test.go   the "turn on the Chrome surface" row
internal/command/page_class_test.go          the commandtest import; the Toggle in the test; the four
                                             browser.* and view.panel.browser on the lists;
                                             view.panel.browser in pageAskFlags
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
2. Turn on Settings › Advanced › Experimental › Chrome surface, or run
   `code-foundry settings set experimental.chrome_surface true` in a terminal that is not a thread's
   (a thread's is refused: the setting is the user's alone).
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
