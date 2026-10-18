# Plugin surfaces: HTML mockups

Static mockups of two plugin side-panel surfaces (see `BRIEF.md`) built only from the
declarative primitives. The page frame, panel chrome and tokens are the MCP panel
sketch's (`../mcp-panel`, `../rendered-thread/style.css`). Each state is a JS view model
(`jenkins.js`, `auth.js`): a pinned `header` plus a `body` array of
`{type, key, ...props}` nodes, the shape a plugin would push. `plugins.js` is the host
renderer, one function per primitive. No markup comes from anywhere else, so the
mockup also shows that the primitives are enough.

## Open and shoot

* `index.html?plugin=jenkins|auth&state=<name>&theme=dark|light`
  * Jenkins states: `running`, `failed`, `succeeded`, `queued`, `unreachable`, `needs-auth`
  * Auth states: `signed-out`, `waiting`, `choose`, `configuring`, `signed-in`, `error`
* `index.html?plugin=list`: the panel's "Open a surface" list (picking: the + is pressed)
  with a plugin tab (Jenkins) in the strip and both plugin surfaces under the built-ins.
* Extra params: `w=280` sets the panel width, `tall` lets the panel grow to fit its
  content, and `outline` labels every node with its primitive name.
* `node shoot.mjs [jenkins,auth,list]` (WebKit, 1440×900 @2x) writes to `shots/`:
  `<plugin>-<state>-<theme>.png` (full page), `…-<theme>-panel.png` (panel crop),
  `<plugin>-<state>-narrow.png` (280px, dark, tall) and `<plugin>-<state>-outline.png`
  (400px, dark, tall, primitives labelled). For `list` the files are `list-<theme>.png`,
  `list-<theme>-panel.png` and `list-narrow.png`. Playwright is loaded from this
  worktree's `gui/frontend/node_modules`, or from the main checkout's if this one has none.

## Primitives used

`header` is a separate field rather than a body node: the host pins it and the body
scrolls under it, so a following log never pushes the build status out of view.

| primitive | role |
|---|---|
| header | icon, title, status pill; a sub line of inline nodes (text, time, link; a link goes to the right) |
| text | paragraph or inline span; tone `muted` / `attention` / `error`; `mono` |
| markdown | small subset (bold, code, links, paragraphs) for explanations |
| pill | status, from the shared status enum |
| time | **new.** Host-formatted and host-ticked `elapsed` / `relative` / `countdown` / `duration` |
| link | opens a URL (host: `view.open.url`); optional trailing icon |
| fields | key-value grid; per row: `mono`, `keyMono`, `secret`, `copy`, value may be an inline node |
| chips | text-only status chips (dot + label + meta), wrapping |
| list | rows: status lead or icon, title, meta, trailing buttons, optional row action |
| log | monospace tail with a title, meta, live marker, copy button; line tone; host scrolls to the end |
| button | variants `default`, `muted`, `attention`, `destructive`; `loading`, `disabled`, `confirm` |
| actions | a row of buttons (wraps) |
| section | uppercase title, optional count, `collapsible`/`open`, `stale` **(new prop)** |
| notice | `info` / `attention` / `error`: tinted border, icon, title, body (inline nodes), actions |
| empty | icon, title, text, actions |
| spinner | inline loader + label + optional meta (a time) |
| progress | determinate (value 0–1) or indeterminate; label + meta |
| code | **new.** A short value to type somewhere else by hand (device code): large mono + Copy |
| form | groups inputs; `submit` and `cancel` buttons; field `error` / `hint` carry validation |
| input, secret, select, checkbox | form controls. `secret` is masked with a Show eye; the mock carries a value only to draw the dots (a real view would send a has-value flag, never the secret) |
| divider | in the renderer, but no state needed it |

One **status enum** is shared by pill, chip and list lead: `ok` (emerald dot, the MCP
precedent), `error` (red), `attention` (amber), `running` (neutral spinner), `pending`
(hollow dot), `skipped` (slashed circle), `neutral` (grey dot). Plugins choose a status,
never a colour.

### State × primitives

| state | primitives |
|---|---|
| jenkins running | header (text, time, link), pill, chips, actions, button (destructive, confirm), log (follow), fields (copy) |
| jenkins failed | header, pill, chips (error, skipped), actions, button (attention, muted), log (line tones), fields; thread attention reason |
| jenkins succeeded | header, pill, chips, actions, button, fields, section (collapsible, closed) |
| jenkins queued | header, pill, empty (with button), section, list (status leads, meta, row actions) |
| jenkins unreachable | header (text, time), pill, notice (error, mono text, loading button), section (stale), chips, fields |
| jenkins needs-auth | header, pill, notice (attention), form, input, secret (error), link, button |
| auth signed-out | header, pill, markdown, actions, button, text (muted) |
| auth waiting | header, pill (running), text, code, spinner (time meta), actions, button ×2 |
| auth choose | header, pill, text, form, select ×2 (hint), section, checkbox ×4, submit + cancel |
| auth configuring | header, pill (running), progress (determinate), list (ok/running/pending leads, meta), actions |
| auth signed-in | header, pill (ok), fields (time value), actions (muted, destructive), section, fields (mono keys, secret), text |
| auth error | header, pill, notice (error, actions), markdown (link) |
| list | host chrome only: tab strip with a plugin tab, the surface list with plugin rows |

Not shown in a state: `toast` (host-level; "Sent to Claude" after the send button
belongs there, not in the body), `divider`, indeterminate `progress`, `info` notice.

## Decisions made in the mockup

* **Header icon is neutral**, not amber like McpSurface's plug: amber means "needs you".
* **Actions sit right under the chips/summary, before the log**, so they stay above the
  fold whatever the log length. All muted except the one the state is about
  (`attention`: Send failure to Claude, Retry, Try again) and wizard steps (`default`:
  Sign in, Continue, Save). No filled primary button anywhere.
* **Destructive looks muted** (red only on hover) and carries a `confirm` string the host
  shows in its confirm dialog. Abort and Sign out are not errors, so they are not red.
* **Logs wrap** with a hanging indent instead of scrolling sideways; at 280px a
  horizontal scroll hides most of every line. Ligatures off (`===` was drawn as a bar).
* **Content inset is 16px at every width.** List rows go 8px into it, so their hover sits
  8px from the pane and their text lines up with everything else.
* **Plugin rows in the surface list**: after the built-ins, behind a divider, with the
  plugin's own icon and a puzzle mark where the hotkey goes. Its tooltip names the plugin
  (hidden information, so a tooltip is allowed).
* **Thread attention** (contribution 4) shows in the failed mock: amber line 2 on the
  sidebar row, the bell badge and the amber dot in the thread header. The panel itself
  does not repeat it.

## Awkward spots

1. **Stage chips at 280px** become a column of 1–2 chips per line (four rows for six
   stages). Blue Ocean's connected-node look is lost by design: connectors break when
   chips wrap. A compact chip variant (dot + name, duration on hover) would contradict
   the tooltip rule. Accepted as is.
2. **The header pill wraps** under the title at narrow widths (`auth-choose-narrow`) and
   ends up right-aligned on a line of its own. Fine, but short pill labels are a
   guideline plugins need (`Waiting`, not `Waiting for browser`).
3. **`time` had to be invented.** Without it the plugin would push a view every second
   to tick "4m 12s" or a countdown. `display` in the data files is mock-only.
4. **`code` had to be invented.** A device code in `fields` reads like metadata; it is
   the one thing on the screen. It could be a `size: large` prop on text plus a copy
   button, but copying is the whole point, so it gets its own primitive.
5. **`section.stale` was needed** for the "last known" block when Jenkins is down: live
   spinners in old data were misleading. A general `dim` would also do.
6. **Inline content** is a separate class of nodes (text, time, link, pill) that may
   appear in header sub lines, notice bodies, field values and spinner meta. The schema
   needs to say which nodes are inline and where they are allowed, or plugins will put a
   log inside a field value.
7. **Checkbox groups** have no label of their own; I used a `section` inside the `form`.
   It works, but a `fieldset` (label + hint + error for the group, e.g. "Pick at least one
   project") would be cleaner.
8. **Copy** appears in three forms (field `copy`, log `copy`, `code`'s button). They
   should all be host-side copies of text already in the view, with no round trip to the
   plugin. The action ids in the data are kept only to show where they go.
9. **Two fields blocks in one state** (signed-in) get separate key columns, so their
   values do not line up. Acceptable; a shared grid across sections would be a layout
   primitive, which I avoided.
10. **Markdown links use sky**, as the thread's do. It is the only non-status colour in
    the surfaces; it comes from the existing markdown style.

## Open questions for Alex

1. Emerald for `ok` (dots, Passed / Signed in pills), as in the shipped MCP cards, or
   strictly neutral per "amber/red only"?
2. Plugin surfaces have no hotkey letters (collisions with built-ins and between
   plugins). Leave them without letters, or let the manifest ask for one and let the
   host refuse taken letters?
3. Should the auth surface also be a Settings entry (it is per user), or only a panel
   tab available everywhere?
4. Do button `confirm` strings go through the host's existing confirm dialog (the command
   registry's), so plugin actions behave like built-in destructive commands?
5. Jenkins `needs-auth` takes a token in a form inside the panel. Is a secret input in a
   plugin view acceptable, or should credentials always go through a host-owned dialog
   (keychain write by the daemon, plugin never sees the field)?
6. Is it acceptable to wrap long log lines, or do logs need a no-wrap option for tables
   and progress bars in Jenkins output?

Committed shots are a curated subset (key states, dark/light, one 280px crop); `node shoot.mjs` regenerates all 77.
