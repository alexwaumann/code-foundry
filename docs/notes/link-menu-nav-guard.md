# Links never navigate the app's window

A user selected text across a GitHub pull request link in a thread, right-clicked the link
and chose WebKit's **Open Link**. The app's own webview loaded GitHub in place of the app;
only the menu's Back item brought it back, and closing and reopening the window did not.

Two causes, two fixes, one PR.

## Why WebKit's menu showed at all

`@wailsio/runtime` (contextmenu.js `processDefaultContextMenu`) hides WebKit's menu only
when nothing is selected, the target is not editable and not an input. With a selection
it lets the menu through, links included. `DefaultContextMenuDisabled` is honoured only on
Windows.

## Part 1: the native navigation guard (gui/navguard*.go)

Wails v3.1.0 sets its own `WKNavigationDelegate` (`WebviewWindowDelegate`,
pkg/application/webview_window_darwin.m) and implements none of its policy methods, so on
macOS nothing stopped a main-frame navigation.

- `cfGuardNavigation` adds `webView:decidePolicyForNavigationAction:decisionHandler:` to the
  delegate's class at runtime (`class_addMethod`; the class comes from the live delegate,
  not a hard-coded name). Wails' own methods stay as they are; nothing is swizzled or
  proxied.
- WebKit reads which methods a navigation delegate has when it is set, so after adding the
  method the guard sets the same delegate again (`view.navigationDelegate = delegate`).
  Without that the method is never called on a webview created earlier.
- The class is shared by every Wails window, so the method is a no-op (allow) on a webview
  that was not guarded: a guarded webview carries its app URL as an associated object.
- If the delegate already has a policy method (a later Wails version), the guard refuses
  to install and logs `navigation guard not installed` with the reason, rather than
  replacing Wails' decision.
- Installed on the main thread from the first `WebViewDidFinishNavigation` (main.go), at the
  page the window then shows: that page's origin is the app's (`wails://wails` built,
  `wails://wails:<port>` under `make gui-dev`), so no origin is hard-coded. The overlay
  panel is guarded the same way (free: it has the same hook). The shot window is not: it
  never takes input and has WebKit's menu disabled.
- The decision is Go (`navigationVerdict`, table test in navguard_test.go): sub-frames go
  anywhere (the HTML preview, plugin pages and their bridge keep their own rules); a
  main-frame navigation in the app's origin (a route, a fragment, a reload) is allowed; any
  other main-frame navigation is cancelled, and an http(s) one opens in the default browser
  instead. Every refusal logs `navigation away from the app refused` to gui.log with the URL.
- The verdict runs inside WebKit's policy callback on the main thread, so it waits on
  nothing: the browser opens from a goroutine.
- A navigation with no target frame (a new-window request: WebKit's "Open Link in New
  Window", `window.open`) is allowed as before. Wails has no `createWebViewWithConfiguration`,
  so it opens nothing; the HTML preview's frame script already sends its links and
  `window.open` to the browser (page-frame-links.md), and turning these into browser opens
  here would open some twice.

Checked in the built app (`make gui-build`, scratch home): with the old link components,
select across the Guide's README link, right-click it, Open Link: the app stays on the Guide,
gui.log has the refusal with `verdict="open in browser"`. A spike build that reloaded the
page after installing the guard logged Wails' start, commit and finish navigation events
again, so its delegate still works. "Search with Google" in WebKit's selection menu goes to
the system browser on its own and never reaches the webview.

## Part 2: the app's own link menu (components/links/WebLink.tsx)

`WebLink` is the one navigable anchor in the app: thread and pull request markdown
(`pr/Markdown.tsx` `Link`) and a plugin's span (`plugin/parts.tsx` `SpanView`) both render
it. Nothing else renders an `<a href>`: Mermaid strips links (mermaid/sanitizeSvg.ts),
terminal links are xterm decorations, and path chips are spans with no href.

- A real `<a href>`, click handled as before (preventDefault, then `open` or openUrl).
- A Radix `ContextMenuTrigger` around it: its `contextmenu` handler prevents the default,
  so WebKit's menu never opens on a link, selection or not, and the Wails runtime sees a
  handled event. An outer trigger (a plugin row with its own menu) skips an event already
  prevented, so only the link's menu opens.
- Items: Open in browser (openUrl, the `view.open.url` command) and Copy link (copyText and a
  "Link copied" toast, as the pull request menu's Copy link). Sentence case, as every other
  menu in the app ("Copy link", "Open in Finder").
- A link that goes nowhere is a plain span and has no menu. Selected plain text, inputs and
  the composer keep WebKit's menu: nothing hides it globally.
- The menu's events stop at its content: it is portalled, but React bubbles them to the
  link's ancestors.
