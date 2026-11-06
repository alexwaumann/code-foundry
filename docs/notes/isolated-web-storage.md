# Web storage per home

A GUI run on any `CODE_FOUNDRY_HOME` but the default one has web storage of its own. Before
this, every build shared WebKit's default store for the bundle id, so a scratch run wrote
panel state, dead terminal ids and `cf.window.lastFocused` keys into the user's real app.
Older step notes that say the isolated copy shares the installed app's storage describe
that time; none of those workarounds (putting settings back before quitting) apply now.

## What it does

- `gui/webstorage.go` decides. The default home, in any spelling (`canonicalHome`, the
  same as the single-instance id), gets no id and nothing is installed: the code path and
  the store are the ones it always had, so there is no migration.
- Any other home gets a UUID derived from its canonical path, and
  `gui/webstorage_darwin.go` makes every webview of the process use
  `+[WKWebsiteDataStore dataStoreForIdentifier:]`. That covers localStorage, IndexedDB,
  cookies and caches, for the main window, the dictation overlay and pages in frames.
- If the store cannot be set, the GUI exits rather than fall back to the default store.
- Same scratch home, same store: panel layout and theme survive a relaunch, as agents
  checking a restart expect. A side-by-side home behaves like a real one.
- Before macOS 14 (the app's floor is 12) a store cannot be named with public API, so
  there a non-default home gets `nonPersistentDataStore`: isolated, but gone on quit. The
  default-store path is not a fallback in any case.

## Why this way

- Wails 3.1.0 builds its `WKWebViewConfiguration` inside `windowNew` and offers no option
  or hook for the store, and `WKWebView.configuration` hands back a copy, so the store has
  to be set during init. The darwin file replaces the implementation of
  `-[WKWebView initWithFrame:configuration:]`, the one init Wails calls, sets
  `websiteDataStore` on the config and calls the original. It is public API on both sides,
  and it needs no Wails fork. If Wails ever exposes the store, drop the wrapper.
- Prefixing the frontend's storage keys was the alternative. It would touch every
  `localStorage` user including `index.html`'s inline script and need a guard test, and
  would not cover frames, IndexedDB or cookies.
- Bundle id, signing identifier and Info.plist do not change, so TCC grants are untouched.
- The store is created lazily inside the first webview's init, because that runs on the
  main thread; `main` runs on whatever thread Go gave it.
- The UUID carries version 4 bits though it is derived, because WebKit lists only those.

## Where it lands

`~/Library/WebKit/dev.alexwaumann.codefoundry/WebsiteDataStore/<uuid>/`, next to the real
store in `WebsiteData/`. The id is in the home's `logs/gui.log` ("web storage of this home").

Gotcha: these directories are never removed. WebKit knows nothing of the home they came
from, so deleting a scratch home leaves about 350 KB behind. With no such GUI running,
`rm -rf ~/Library/WebKit/dev.alexwaumann.codefoundry/WebsiteDataStore` clears them all and
cannot touch the real store.

Gotcha: a home that does not exist yet resolves as given, so `/tmp/x` launched from a
terminal for the first time gets another id than on later runs (`/private/tmp/x`). A launch
without a terminal creates the home first, through its log. The only effect is one empty
store, as with the single-instance id.

## Verified

Standalone harness first, with the real Objective-C and no bundle id, so it could not reach
the app's store: the webview reported the named store, a second webview shared it, a bad
UUID was refused, and with `defaultDataStore` never called no `WebsiteData` directory was
created at all. That is what made the first scratch launch safe.

Then the built app, with a throwaway build (not committed) reporting `localStorage` to a
local listener, on two scratch homes:

- A wrote a marker into an empty store (no `code-foundry.*` keys, so not the real one).
- B saw no marker, wrote its own. Relaunched, each saw only its own marker.
- A sha256, mtime and size manifest of the 340 files of the real store and its caches was
  identical before and after, as were the mtimes of the directories below its top one. The
  top directory does gain `WebsiteDataStore`.
- The unmodified build on a third home opened, rendered and connected to its daemon. With
  `dictation.anywhere` on it stayed up; the overlay is hidden, so its second webview was
  seen in the harness, not on screen.

No launch on the default home: the claim there rests on the table test and on nothing
being installed when the id is empty.
