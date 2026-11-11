# Plugin surface shot page (2026-11-10)

`plugin surface --shot out.png` will write a PNG of a plugin surface as the app draws it, so an
agent can look at what its plugin drew. This PR is the page the capture loads: one surface
alone, with the real components and theme and no app chrome, and a controller that says when
it is ready. The daemon side and the Wails host (a hidden window that loads the page, drives
it and captures it) are sibling and later PRs; nothing here binds to Wails or changes a proto.

## What shipped

* `gui/frontend/shot.html` + `src/shot/`: a third Vite input (`vite.config.ts`, beside the
  dictation overlay's). `main.tsx` wires the page, `controller.ts` runs requests,
  `Stage.tsx` / `stageStore.ts` show the one surface at the window's size (`h-screen w-screen`).
* `components/plugin/PluginSurface.tsx` split: `PluginSurfaceBody` takes the watch key,
  plugin, surface and context (and `unavailable` for the panel's notice) and draws the
  header, tabs, strips, body and the host's states. `PluginSurface`, the panel tab, keeps what
  is the panel's: the loaded/missing states, the show state, the one `WatchSurface` per tab
  and the tab's title. No behaviour change in the panel.
* `src/api`: `listPlugins` (PluginService.List, for a window without the event stream),
  `SurfaceRefView.instance` (WatchSurface by an instance key), `getPublishedTheme`
  (UiService.GetTheme with its scheme).

## The contract (what the host PR binds to)

Request, `ShotRequest` (`src/shot/controller.ts`):

```
{ id: string,               // echoed in the report
  plugin: string, surface: string,
  instance?: string,        // "<plugin>/<surface>/<scope id>" of an instance the daemon has;
                            // in place of scope, and plugin/surface default to its parts
  scope?: string,           // "global" (default) | "thread:<id>" | "project:<id>" | "worktree:<path>"
  minVersion?: number,      // the oldest view version the shot may show (default 1)
  timeoutMs?: number }      // default 10 000
```

A pr scope has no context of its own (the daemon derives it from a thread), so it goes by
`instance`. Report, `ShotReport`, exactly one per request:

```
{ id, ok: true,  contentHeight: number, version: number }
{ id, ok: false, failure: "plugin-down" | "failed" | "unavailable" | "timeout" | "invalid", reason: string }
```

* **ok** once the stream's phase is `live`, its version ≥ `minVersion`, the theme and plugin
  manifests are read (failures there only warn), `document.fonts.ready` resolved and two
  animation frames passed. `contentHeight` is the surface's height with its scroll area
  unrolled, rounded up, in CSS px: never less than the window's height (the scroll area fills
  the window), so a caller wanting the whole surface resizes the window to it and asks again.
  `version` is the one on screen when measured.
* **plugin-down**: phase `plugin-down` with the plugin crashed, failed, disabled or stopped.
  A plugin `starting` (a dev plugin rebuilt) is waited for.
* **failed**: phase `failed` (the instance could not open).
* **unavailable**: the stream errored: not available in this context, no such plugin,
  surface or instance, or the daemon unreachable; `reason` is the daemon's words.
* **timeout**: none of the above within `timeoutMs`; `reason` names the phase and version it
  got to (`not-responding` is waited through, so it ends here).
* **invalid**: no plugin and surface, or a scope that is not one of the four.

A new request replaces the one in hand: the old surface unmounts and never reports. After a
report the surface stays on screen until the next request, so the capture follows the report.

Entry points: `window.cfShot(request)`, and the URL
(`/shot.html?plugin=…&surface=…&scope=…&instance=…&minVersion=…&timeoutMs=…&id=…`, id
default `url`), which runs one request at load. The report goes through `report` in
`main.tsx`; the host PR adds its bound call there. Without a host the report marks `<html>`:
`data-shot-id`, and `data-shot-ready="<contentHeight>"` or `data-shot-error="<failure>: <reason>"`
(all three cleared when a request starts).

## Decisions and gotchas

* **The controller follows the store, not the stream.** The page starts the watch with
  `startSurfaceWatch` under its own key per request (`shot\0<n>\0<id>`), so the body draws from
  the same store as the panel, and the controller reads the entries. The store keeps the
  stream's error only as text, so every stream error is `unavailable` with that text.
* **Theme from `GetTheme` per request**, set on `<html>` as the app's `syncDocumentScheme`
  does (slots, `data-theme`, `dark`, `color-scheme`). The window has no theme engine; reading
  per request keeps a long-lived hidden window current.
* **Manifests by `PluginService.List` per request**, seeded into the plugins store as a
  snapshot, so the header's fallback title and icon are the manifest's.
* A `TooltipProvider` wraps the stage (radix needs one); no toaster, so a plugin's toasts
  draw nothing in a shot.
* For the host PR: the dictation overlay's note explains why that page uses `localhost`
  (WebKit's per-host connection pool is shared between windows). Streams now ride the
  socket tunnel, so a shot window's one surface stream should not starve the main window,
  but a surface with thread or terminal nodes opens more.

## Tests

* `src/shot/controller.test.ts`: waits for live and the version and the fonts; overflow
  height; each failure; waiting through `starting`; timeouts; a second request replacing the
  first; `targetOf` and `requestFromSearch`.
* `PluginSurface.test.tsx`: the panel tab's own states across the split (unavailable notice
  with no stream, gone, opening); the existing panel tests are unchanged.
* `e2e/shot-page.spec.ts`: against the mock, the stage is the window's width and the ready
  mark appears; `SHOTS=<dir>` writes dark and light screenshots at the reported height.
