# Plugin surfaces: UI primitives and the view model

Status: design only, 2026-10-14. Companion to `BRIEF.md` (decisions), `ARCHITECTURE.md`
(daemon, protocol, lifecycle) and `index.html` (mockups built from these primitives).
Reference look: the MCP surface (`components/mcp/McpSurface.tsx`, sketch B), the
Workspace and Linked PRs surfaces, `components/pr/tones.ts`, the settings editors.

## Summary

* **v1 set (13 node types + header):** header, text, markdown, pairs, list, chips, log,
  actions (buttons), progress, notice, empty, section, form (input, select, toggle).
  Shared value types: tone, status, glyph, inline (text runs with ticking times and
  links), pill, button, action.
* **Updates: full-view replacement**, plus one narrow append op for log nodes. Input
  values are host-owned drafts until submit; the plugin's value shows only while a field
  is pristine. Keyed reconciliation and structural sharing keep focus, scroll and
  render cost where they are.
* **Actions are commands first.** A button that does something a user would do from the
  palette or CLI (Abort, Rebuild, Sign out) names a registered `plugin.<name>.<verb>`
  command (confirm dialogs, keybindings, CLI for free; the CLAUDE.md "every user action
  is a command" rule). Surface events are for view-local interaction (pick a stage, a
  form field changed, Cancel a wizard step) and for forms carrying secrets.

---

## A. Primitive catalog

### Changes to the seed list

| Seed | Decision | Reason |
|---|---|---|
| header | **added** (`ViewHeader`, one per view, not a node) | Every surface has the `shdr` header (icon, title, trailing count, subline, refresh); making it a fixed slot keeps plugins identical to MCP/Workspace. |
| text | kept, gains `size: lg` and `copyable` | Covers the device code (large mono + Copy) without a new primitive. |
| markdown | kept | Explanatory copy with links and emphasis; the renderer exists (`pr/Markdown`). |
| status pill | **demoted to a slot** (`pill` on header, row, section, pair) | A free-floating pill has no layout home; every observed pill sits beside a title. |
| key-value fields | renamed **`pairs`** | "Field" is taken by form fields. |
| chip row | renamed **`chips`**, chips carry status + meta + select action | Blue Ocean stage strip is the use; generic enough for any step strip. |
| list | kept; rows carry glyph, title, title_meta, pill, line2, trailing, actions | One row shape = MCP card header + workspace member row. Also renders step lists (configuring). |
| log block | kept as **`log`**, with an append op | The one high-volume, high-frequency node; see B. |
| button | **not a node**; lives in `actions`, header, row, section, notice, empty, form | Free buttons invite ad-hoc layouts; containers own wrapping at 280px. |
| link | **cut as a node**; `open_url` action on buttons (`style: link`) and `url` on inline spans | A link is an action with a host-side handler, not a layout element. |
| text input + secret input | **merged** into `input {kind: text \| secret}` | Same layout, label, validation; secret only changes transport and echo rules. |
| select | kept, `style: dropdown \| list` and `multiple` | Wizard choices with descriptions read better as radio rows; project scope needs multi. |
| checkbox/toggle | kept as **`toggle`** (switch) only | The app has one boolean control (settings `BoolEditor`); checkboxes appear only as `select{multiple, style: list}`. |
| progress | kept (determinate + indeterminate) | Configuring step, device-code wait. |
| section | kept, **merged with "card"** (`card: true`, `tone` border) | Same container, different chrome; MCP cards are sections with a frame. |
| inline notice | kept as **`notice`** (neutral / attention / error) | Unreachable, needs auth, sign-in failed, expiring. |
| toast | **not a node**; an optional `toast` in an event's reply, and command results | Ephemeral, not view state; only shown in answer to the user's own action. |
| empty state | kept as **`empty`** | First-run and "nothing yet" bodies with one call to action. |
| divider | **cut** | Sections and cards separate content; a free rule invites decoration. Deferred if a real need shows. |
| spinner | **cut**; `glyph{status: running}` anywhere a glyph goes, `progress` standalone | Every spinner in both plugins is attached to a row, chip, button, empty state or progress. |
| forms | **added** (`form`: fields + submit + secondary buttons, field and form errors, busy) | The one way input values travel. |
| tabs / segmented | **deferred** | Neither plugin needs it; flow = replace the view. `usage/Segmented.tsx` is ready when one does. |
| time | **added as an inline span** (`relative`, `elapsed`, `countdown`) | Elapsed build time and token expiry must tick; a re-render per second from the plugin is waste. |
| glyph | **added as a shared value** (status or allowlisted lucide icon) | One status vocabulary across plugins: same dots and icons as MCP and PR checks. |

### Shared value types

| Type | Shape | Rules |
|---|---|---|
| **tone** | `neutral` (default) · `muted` · `attention` · `error` · `ok` | amber = needs you, red = error. `ok` (emerald) is honoured only in pills and status glyphs, as MCP "Connected" and PR checks already do; on text, borders and buttons it renders neutral. Colours: `pr/tones.ts` `toneText`/`toneBadge`, MCP `PILL`/`DOT`; tokens `--amber`, `--red`, `--emerald`, `--muted-fg` in both schemes. |
| **status** | `ok` · `failed` · `attention` · `running` · `pending` · `skipped` · `off` | Host maps to look. Dot style (rows, default): emerald / red / amber dot, `LoaderCircle` spin, muted/60 dot, hollow ring, hollow ring. Icon style (chips, step lists): `CircleCheck` emerald, `CircleX` red, `TriangleAlert` amber, `LoaderCircle` spin muted, `CircleDashed` muted, `CircleSlash` muted, `Ban` muted. |
| **glyph** | `{status}` or `{icon, tone}` | `icon` is a kebab lucide name from a host allowlist (~60: workflow, key-round, git-pull-request, external-link, refresh-cw, square, rotate-ccw, send, copy, log-in, log-out, server, database, clock, timer, hourglass, shield-check, …); unknown names render `Circle`. No custom SVG (iframe tier). |
| **inline** | `{text}` or `{spans: [{text \| time, tone, mono, strong, url}]}` | Used where content may mix tones, links or ticking times: header trailing/subline, row line2/trailing/title_meta, pair values, chip meta, text, notice body. Plain `string` everywhere else (labels, titles). A span with `url` is a link (http/https only), opened by the host (`view.open.url`). |
| **time** | `{at: timestamp, style: relative \| elapsed \| countdown}` | Host formats on a shared 1 s clock in its own tiny component (as `CheckedText` in MCP), so only the span re-renders. `relative`: "12s ago" / "in 3 days"; `elapsed`: "4m 12s" counting up from `at`; `countdown`: "9:41" then "expired". Static durations ("took 1m 40s") are plain text from the plugin. |
| **pill** | `{label, tone}` | MCP pill: `rounded-full px-1.5 text-[10.5px] leading-4 font-medium`, tinted bg 15% + tone text; neutral = `bg-muted text-muted-foreground`. Never shrinks; neighbours truncate first. |
| **action** | one of `event` (id + opaque `data` ≤ 1 KB) · `command {name, args}` · `open_url` · `copy` | `command`: the plugin's own `plugin.<name>.*` commands plus host commands its manifest is granted; invoked through `CommandService.Invoke` with the panel's context, so `Confirm` dialogs and command result toasts come free. `open_url` and `copy` never reach the plugin (no pending state). |
| **button** | `{key, label, icon?, style, action, disabled, busy, icon_only}` | See below. |

**Button.** Renders `ui/button` `size="xs"` (h-6, text-xs, icon 3.5) with the MCP
classes; command buttons can render through `CommandButton` (availability, title).

| style | Look | When |
|---|---|---|
| `muted` (default) | borderless, `text-muted-foreground`, hover `bg-accent` | Almost everything (Rebuild, Open in Jenkins, Refresh). Always visible, never hover-revealed. |
| `outline` | `border-border`, fg text | A secondary step with some weight (form secondary). |
| `attention` | amber border/40 + amber text (MCP Reconnect on a failed card) | The one thing that needs the user next ("Send failure to Claude", "Try again"). |
| `destructive` | muted; red text on hover and focus ring | Abort, Sign out. The real weight is the command's `Confirm` dialog. |
| `primary` | filled `bg-primary` | At most one per view (host demotes extras to `outline`): the wizard's main step and form submits. |
| `link` | inline text, underline on hover | "Open the page again", "Use a different account". |

States: `disabled` (opacity 50, no pointer); **pending** (host-owned: from click until the
plugin's reply or the command's return; `LoaderCircle` replaces the icon, disabled);
`busy` (plugin-owned: same look, for operations that outlive the reply, e.g. "Rebuild"
until Jenkins accepts the build). `icon_only` requires `label` (aria-label and `title`;
the only tooltip, since the label is otherwise hidden). Width: never shrinks; a button
bar wraps.

### Layout rules (all primitives)

* The body is an `@container` scroll box (`data-scroll-root`, `overflow-auto`), as every
  surface. Padding 8 px left and right (panel rows sit 8 px from the pane); text-bearing
  nodes (text, markdown, pairs, progress) add 8 px inside so their text lines up with the
  header's 16 px (`px-4`); under 340 px the header drops to 12 px and inner pads to 4 px.
  Cards (`section{card}`) and notices use the MCP card box: `rounded-[10px] border px-3
  pt-2.5 pb-2`.
* Vertical rhythm: 12 px between top-level nodes, 6 px inside sections and cards.
* Every horizontal row follows the MCP long-names rule: primary text `shrink-0
  max-w-full truncate`, secondary text `min-w-0 truncate` and gives way first, pills,
  glyphs and buttons `shrink-0` outside the group, full text in `title`. The body never
  scrolls sideways (the log scrolls inside itself).
* Nothing is hover-revealed; tooltips only on icon-only buttons and truncated text.

### Primitives

Need column: **all** = every tool-panel UI needs it; **J** = Jenkins only; **A** = auth only.

| # | Primitive | Need | v1 | Renders with |
|---|---|---|---|---|
| 0 | header | all | v1 | MCP/Workspace `Header` pattern (extract a shared `SurfaceHeader`) |
| 1 | text | all | v1 | `<p>`/`<span>` + `thread/CodeActions` `CopyButton` |
| 2 | markdown | all | v1 | `pr/Markdown` (raw HTML as text; links via `view.open.url`) |
| 3 | pairs | all | v1 | `<dl>` grid like `thread/rows.tsx` question detail |
| 4 | list | all | v1 | MCP card header row + `workspace` member rows; `pr/VirtualStack` over 40 rows |
| 5 | chips | J | v1 | new; tones from `pr/tones.ts`, icons lucide |
| 6 | log | J (most tool UIs) | v1 | new; `font-mono` block in the terminal palette (`thread.css`), `CopyButton` |
| 7 | actions | all | v1 | flex-wrap row of `ui/button` xs |
| 8 | progress | A | v1 | new (`role="progressbar"`, as `update/UpdateDialog`) |
| 9 | notice | all | v1 | MCP card with tone border + MCP error/login-hint lines |
| 10 | empty | all | v1 | MCP `Message` / panel `EmptyState` layout |
| 11 | section | all | v1 | MCP card (card), sketch C group header (`.gh`) for titles, `ChevronRight` disclosure |
| 12 | form | A (J for the token) | v1 | settings `inputClass`, `EnumEditor` (native select), `BoolEditor` (switch) |
| – | toast | all | v1 (reply field) | `sonner` |
| – | segmented/tabs, table, divider, image/avatar, multiline input, row disclosure, overflow menu, chart/graph | – | deferred | – |

#### 0. header (`ViewHeader`)

Purpose: the surface's identity and freshness line, identical to MCP/Workspace.

| Prop | Type | Default |
|---|---|---|
| `icon` | allowlisted lucide name | manifest icon |
| `title` | string ≤ 120 | manifest title |
| `trailing` | inline, muted, `tabular-nums` | none |
| `pill` | pill (after trailing) | none |
| `subline` | inline | none |
| `subline_icon` | lucide name | none |
| `actions` | ≤ 2 icon-only buttons at the subline's end (refresh) | none |
| `tab_title` | string ≤ 40, replaces the manifest title in the tab strip | manifest |

Interactive: `actions`, span `url`s. States: before the first render the host draws the
manifest icon + title and a "Loading…" message. Layout: two lines, `px-4 pt-2 pb-2.5`
(`px-3` under 340), border-bottom `pane-border`; title truncates, trailing and pill
never. Icon renders muted-foreground (not plugin-coloured; see open question 2).

#### 1. text

Purpose: a sentence or a value to copy. Props: `content` inline (required), `size`
`sm` (12 px, muted default) · `base` (13 px, default) · `lg` (18 px, mono, letter-spaced:
codes), `copyable` bool (false; a muted Copy icon button right of it, copies the plain
text, check state for 1.5 s). Interactive: span urls, copy (host only). Wraps; `lg` never
wraps (`whitespace-nowrap`, scales down to fit at 280 px via `text-[clamp(...)]`).
Selectable text (`select-text`), unlike most chrome.

#### 2. markdown

Purpose: explanatory copy with emphasis, lists, inline code and links. Props: `source`
string ≤ 16 KB (GFM). Raw HTML is shown as text, images are not loaded, links open
through the host, code blocks get Copy (not Run in terminal). 13 px, `prose` spacing
of the PR body. Same in both schemes (the renderer is theme-aware already).

#### 3. pairs

Purpose: facts about one thing (account, environment, expiry, build number).

| Prop | Type | Default |
|---|---|---|
| `items[]` | `{key, label string ≤ 40, value inline, pill?, copyable bool}` | – |

Layout: `grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs`, labels muted, values fg and
truncating (full text in `title`); under 300 px container width it stacks (label above
value). Interactive: span urls, copy.

#### 4. list

Purpose: a list of things (servers, injected env vars, steps, builds).

| Prop | Type | Default |
|---|---|---|
| `rows[]` | row | – |
| `glyph_style` | `dot` · `icon` | `dot` |
| `dense` | bool: 24 px single-line rows (steps, env vars) | false: 2-line rows |
| `empty_text` | string shown when `rows` is empty | none (list hidden) |

Row: `key`, `glyph?`, `title` string, `title_meta?` inline (mono secondary, gives way
first, like the MCP version), `pill?`, `line2?` inline (muted; amber/red when the row
needs attention, like the sidebar's coloured second line), `trailing?` inline (muted,
right), `actions[]` ≤ 3 (icon-only ones sit trailing; labelled ones on a line under
line2, as MCP's Reconnect), `action?` (whole row clickable, Enter when focused; hover
`bg-accent`), `selected` bool (accent background). Interactive: row action, row buttons,
span urls. States: per-button pending/busy; a running glyph is the row's own spinner.
Over 40 rows the list virtualizes against the body (`VirtualStack`). Rows span the 8 px
inset with 8 px inner padding, `rounded-md`.

#### 5. chips

Purpose: a strip of stages or steps with status and duration (Blue Ocean, flattened).

| Prop | Type | Default |
|---|---|---|
| `chips[]` | `{key, label string ≤ 32, status, meta? inline, selected bool, action?}` | – |

Look: h-6 `rounded-md border border-border px-2 text-xs`, status icon left, label fg,
meta muted `tabular-nums`; `failed` chip: border red/35 and red label, `attention` amber
the same, `ok` keeps a neutral border (emerald only in the icon); `selected`:
`bg-accent`. Wraps onto more lines (`flex-wrap gap-1.5`), never scrolls; at 280 px a
5-stage pipeline takes two lines. Interactive: chip action (usually an event: show this
stage's log). Arrow keys move between chips (roving tabindex).

#### 6. log

Purpose: a monospace tail (build log, command output) the plugin streams.

| Prop | Type | Default |
|---|---|---|
| `text` | string; replaced by a render, extended by `surface/append` | "" |
| `no_follow` | bool: do not stick to the bottom | false (tail-follows) |
| `rows` | visible height in lines, 4–40 | 16 |
| `wrap` | bool: soft-wrap lines | false (scrolls sideways inside the box) |
| `truncated` | bool: the plugin trimmed the head ("earlier output not shown" line on top) | false |
| `title` | string, muted caption above, left of the Copy button | none |

Look: `rounded-md border bg-muted/40 font-mono text-[11.5px] leading-4`, the terminal
palette's fg. Copy (always visible, muted, top right) copies the whole buffer. Follow
rule: sticks to the bottom while the user is at the bottom; scrolling up stops following
and shows a muted "Jump to end" button; selection survives appends (only text nodes are
added). ANSI escapes are stripped in v1 (open question 5). The host keeps at most the
last 2,000 lines / 256 KB and trims the head (`truncated` then shows).

#### 7. actions

Purpose: a bar of buttons under the content they act on. Props: `buttons[]` (≤ 6),
`align` `start` (default) · `end`. `flex flex-wrap gap-1.5`; buttons never shrink, the bar
wraps. Each button is pending on its own; other buttons stay enabled (the plugin
disables conflicting ones itself).

#### 8. progress

Purpose: one operation's progress. Props: `value` optional double 0–1 (absent =
indeterminate), `label` string, `meta` inline (right, muted: "2 of 4", a countdown),
`tone` (`error` when it failed; else neutral). Look: label + meta on one 12 px line,
a 4 px `rounded-full bg-muted` track with a `bg-foreground/60` fill (indeterminate: a
sliding 30 % segment, `motion-reduce` shows a static 30 % fill). Not interactive.

#### 9. notice

Purpose: a state the user should know about inside the surface (unreachable, needs
auth, sign-in failed, expiring soon). Props: `tone` `neutral` (info) · `attention` ·
`error` (default neutral), `title` string, `body` inline, `detail` string ≤ 2 KB (mono,
wraps, `break-words`: the raw error, like MCP's), `icon` (default `Info`,
`TriangleAlert`, `CircleAlert` per tone), `actions[]` ≤ 3. Look: the MCP card box with
a tone/35 border, title in the tone colour, body neutral, detail in the tone colour
(MCP error line). No filled background. Interactive: buttons, urls.

#### 10. empty

Purpose: the whole body when there is nothing yet, with one call to action. Props:
`glyph` (icon or a running status for "waiting"), `title`, `body` inline, `actions[]`
≤ 2. Centered in the body's upper third, `max-w-64`, title 14 px medium, body 13 px
muted; buttons below. Using `primary` here is the norm (Sign in).

#### 11. section

Purpose: group nodes under a title, optionally framed as a card or collapsible.

| Prop | Type | Default |
|---|---|---|
| `title` | string ≤ 60 | none (untitled group) |
| `meta` | inline, right of the title | none |
| `pill` | pill | none |
| `actions[]` | ≤ 2 buttons right of the title (icon-only at 280 px) | none |
| `collapsible` / `collapsed` | bools; `collapsed` is the initial state, the user's toggle then wins for the instance's life | false / false |
| `card` | bool: MCP card frame | false |
| `tone` | `attention` / `error` tint the card border (MCP needs-login/failed) | neutral |
| `children[]` | nodes; a section may hold sections only if it is not itself inside one (depth ≤ 3) | – |

Title look: sketch C's group header (`text-[11px] uppercase tracking-[.06em]` muted;
amber when `tone: attention`). Collapsible: `ChevronRight` rotating, the whole title
row is the toggle (host-only, no event).

#### 12. form

Purpose: the only way values travel to the plugin: fields, a submit, secondary buttons,
validation and pending state.

| Prop | Type | Default |
|---|---|---|
| `fields[]` | form field (below) | – |
| `submit` | button; action `event` or `command` | none (a form of `change` fields, like settings) |
| `secondary[]` | buttons (Cancel, Back) | none |
| `error` | string, form-level, red under the fields | none |
| `busy` | bool: keep the form pending after the reply | false |
| `reset_token` | string: a change drops every draft | "" |

Field: `key`, `name` (value key in the payload and the command arg name), `label`,
`description` inline (muted, under the control), `error` string (red, under the control,
replaces the description), `required`, `disabled`, `change` action (event only), and one
control:

* **input** `{kind: text | secret, value, placeholder, max_length, pattern,
  pattern_message, mono, has_value}`: settings `inputClass` (h-7 text-xs, full width).
  `secret` is a password field; its value is never sent back in a render (the plugin
  sets `has_value` to show "Saved · type to replace"), never in a `change` event, never
  logged by the daemon, and a form holding one must submit through an `event`, not a
  command (command args reach argv and logs).
* **select** `{options[{value, label, description?, disabled}], value[] , multiple,
  style: dropdown | list, placeholder}`: `dropdown` is the native select of
  `EnumEditor`; `list` is radio (or checkbox when `multiple`) rows with descriptions,
  8 px rows like the list primitive. `multiple` implies `list`.
* **toggle** `{value bool}`: the settings switch (h-5 w-9), label left, switch right.

Validation: the host checks `required`, `max_length`, `pattern` (JS-compatible RE2
subset) on blur and on submit, shows the message under the field, and blocks the submit
until valid. Server-side errors come back in the next render (`field.error`,
`form.error`). Enter in a text input submits; Escape reverts the field to the plugin's
value. Pending: from submit until the reply every field and button of the form is
disabled and the submit spins; `busy` extends that.

### Recommended sets

**v1:** header, text, markdown, pairs, list, chips, log (+ append), actions, progress,
notice, empty, section, form (input text/secret, select dropdown/list/multiple, toggle),
the reply toast. Every one is exercised by the two plugins (D), and all but chips,
progress and secret input by any tool panel.

**Deferred:** segmented/tabs (sub-views of one surface), table (columns at 280 px are
poor; pairs + list cover it), divider, image/avatar (needs an image proxy for
authenticated URLs), multiline input, row disclosure (MCP's tools list; a collapsible
section covers it), overflow menu on rows (> 3 actions), ANSI colours in logs, chips with
parallel branches, charts/graphs/sparklines (iframe tier), sticky footer bar.

---

## B. The view-model schema

Sketch of `proto/codefoundry/v1/plugin_view.proto` (owned by the service that streams
views to the GUI; see `ARCHITECTURE.md`). The plugin speaks JSON-RPC: its payloads are
the protojson of these messages. The daemon's decoder accepts two shorthands: short
lowercase enum names (`"error"` for `VIEW_TONE_ERROR`, resolved through the enum
descriptor) and a bare string where a `ViewInline` is expected (`{"text": s}`). D uses
both.

```proto
// What a plugin last rendered for one surface instance. The plugin sends it whole;
// the daemon stamps instance_id and rev, keeps the latest, and streams it to viewers.
message PluginView {
  string instance_id = 1;          // set by the daemon
  uint64 rev = 2;                  // set by the daemon; grows with every accepted render
  ViewHeader header = 3;
  repeated ViewNode nodes = 4;
}

message ViewHeader {
  string icon = 1;                 // allowlisted lucide name; empty: the manifest's
  string title = 2;                // empty: the manifest's
  ViewInline trailing = 3;
  ViewPill pill = 4;
  ViewInline subline = 5;
  string subline_icon = 6;
  repeated ViewButton actions = 7; // icon-only, at most 2
  string tab_title = 8;
}

// One element of the body. key is unique within the whole view (nodes, rows, chips,
// pairs, buttons, form fields and options share one namespace): [A-Za-z0-9._:-]{1,64}.
// It is React's key, the target of surface/append, and node_key in events.
message ViewNode {
  string key = 1;
  oneof kind {
    ViewText text = 10;
    ViewMarkdown markdown = 11;
    ViewPairs pairs = 12;
    ViewList list = 13;
    ViewChips chips = 14;
    ViewLog log = 15;
    ViewActions actions = 16;
    ViewProgress progress = 17;
    ViewNotice notice = 18;
    ViewEmpty empty = 19;
    ViewSection section = 20;
    ViewForm form = 21;
  }
}

// ---- shared values ----

enum ViewTone {
  VIEW_TONE_UNSPECIFIED = 0;       // neutral
  VIEW_TONE_MUTED = 1;
  VIEW_TONE_ATTENTION = 2;         // amber: needs the user
  VIEW_TONE_ERROR = 3;             // red
  VIEW_TONE_OK = 4;                // emerald; pills and status glyphs only
}

enum ViewStatus {
  VIEW_STATUS_UNSPECIFIED = 0;     // no glyph
  VIEW_STATUS_OK = 1;
  VIEW_STATUS_FAILED = 2;
  VIEW_STATUS_ATTENTION = 3;
  VIEW_STATUS_RUNNING = 4;         // spinner
  VIEW_STATUS_PENDING = 5;         // queued, not started
  VIEW_STATUS_SKIPPED = 6;
  VIEW_STATUS_OFF = 7;             // aborted, disabled
}

message ViewGlyph {
  oneof kind {
    ViewStatus status = 1;
    string icon = 2;               // allowlisted lucide name
  }
  ViewTone tone = 3;               // icon only; OK is ignored
}

message ViewInline {
  string text = 1;                 // shorthand for one plain span
  repeated ViewSpan spans = 2;     // used when set; text is then ignored
}

message ViewSpan {
  oneof kind {
    string text = 1;
    ViewTime time = 2;
  }
  ViewTone tone = 3;
  bool mono = 4;
  bool strong = 5;
  string url = 6;                  // http(s); the span is a link the host opens
}

enum ViewTimeStyle {
  VIEW_TIME_STYLE_UNSPECIFIED = 0; // relative
  VIEW_TIME_STYLE_RELATIVE = 1;    // "12s ago", "in 3 days"
  VIEW_TIME_STYLE_ELAPSED = 2;     // "4m 12s" since at, ticking
  VIEW_TIME_STYLE_COUNTDOWN = 3;   // "9:41" until at, then "expired"
}

message ViewTime {
  google.protobuf.Timestamp at = 1;
  ViewTimeStyle style = 2;
}

message ViewPill {
  string label = 1;
  ViewTone tone = 2;
}

message ViewCommand {
  string name = 1;                 // plugin.<name>.<verb>, or a granted host command
  map<string, string> args = 2;
}

message ViewAction {
  oneof kind {
    string event = 1;              // sent to the plugin as a surface event
    ViewCommand command = 2;       // CommandService.Invoke with the panel's context
    string open_url = 3;           // host: view.open.url
    string copy = 4;               // host: clipboard, ≤ 64 KB
  }
  string data = 5;                 // event only: echoed back verbatim, ≤ 1 KB
}

enum ViewButtonStyle {
  VIEW_BUTTON_STYLE_UNSPECIFIED = 0; // muted
  VIEW_BUTTON_STYLE_MUTED = 1;
  VIEW_BUTTON_STYLE_OUTLINE = 2;
  VIEW_BUTTON_STYLE_ATTENTION = 3;
  VIEW_BUTTON_STYLE_DESTRUCTIVE = 4;
  VIEW_BUTTON_STYLE_PRIMARY = 5;     // one per view
  VIEW_BUTTON_STYLE_LINK = 6;
}

message ViewButton {
  string key = 1;
  string label = 2;                // required, also for icon_only (aria-label, title)
  string icon = 3;
  ViewButtonStyle style = 4;
  ViewAction action = 5;
  bool disabled = 6;
  bool busy = 7;                   // plugin-owned pending
  bool icon_only = 8;
}

// ---- nodes ----

enum ViewTextSize {
  VIEW_TEXT_SIZE_UNSPECIFIED = 0;  // base, 13px
  VIEW_TEXT_SIZE_SM = 1;           // 12px, muted unless spans say otherwise
  VIEW_TEXT_SIZE_LG = 2;           // 18px mono: codes
}

message ViewText {
  ViewInline content = 1;
  ViewTextSize size = 2;
  bool copyable = 3;
}

message ViewMarkdown {
  string source = 1;               // ≤ 16 KB
}

message ViewPair {
  string key = 1;
  string label = 2;
  ViewInline value = 3;
  ViewPill pill = 4;
  bool copyable = 5;
}

message ViewPairs {
  repeated ViewPair items = 1;
}

enum ViewGlyphStyle {
  VIEW_GLYPH_STYLE_UNSPECIFIED = 0; // dot
  VIEW_GLYPH_STYLE_DOT = 1;
  VIEW_GLYPH_STYLE_ICON = 2;
}

message ViewRow {
  string key = 1;
  ViewGlyph glyph = 2;
  string title = 3;
  ViewInline title_meta = 4;
  ViewPill pill = 5;
  ViewInline line2 = 6;
  ViewInline trailing = 7;
  repeated ViewButton actions = 8; // at most 3
  ViewAction action = 9;           // the whole row
  bool selected = 10;
}

message ViewList {
  repeated ViewRow rows = 1;
  ViewGlyphStyle glyph_style = 2;
  bool dense = 3;
  string empty_text = 4;
}

message ViewChip {
  string key = 1;
  string label = 2;
  ViewStatus status = 3;
  ViewInline meta = 4;
  bool selected = 5;
  ViewAction action = 6;
}

message ViewChips {
  repeated ViewChip chips = 1;
}

message ViewLog {
  string text = 1;                 // replaced by a render; surface/append extends it
  bool no_follow = 2;
  uint32 rows = 3;                 // 4..40, 0 = 16
  bool wrap = 4;
  bool truncated = 5;
  string title = 6;
}

enum ViewAlign {
  VIEW_ALIGN_UNSPECIFIED = 0;      // start
  VIEW_ALIGN_START = 1;
  VIEW_ALIGN_END = 2;
}

message ViewActions {
  repeated ViewButton buttons = 1; // at most 6
  ViewAlign align = 2;
}

message ViewProgress {
  optional double value = 1;       // 0..1; absent = indeterminate
  string label = 2;
  ViewInline meta = 3;
  ViewTone tone = 4;               // ERROR when it failed
}

message ViewNotice {
  ViewTone tone = 1;               // neutral (info), ATTENTION, ERROR
  string title = 2;
  ViewInline body = 3;
  string detail = 4;               // mono, ≤ 2 KB
  string icon = 5;
  repeated ViewButton actions = 6; // at most 3
}

message ViewEmpty {
  ViewGlyph glyph = 1;
  string title = 2;
  ViewInline body = 3;
  repeated ViewButton actions = 4; // at most 2
}

message ViewSection {
  string title = 1;
  ViewInline meta = 2;
  ViewPill pill = 3;
  repeated ViewButton actions = 4; // at most 2
  bool collapsible = 5;
  bool collapsed = 6;              // initial; the user's toggle wins afterwards
  bool card = 7;
  ViewTone tone = 8;               // card border: ATTENTION or ERROR
  repeated ViewNode children = 9;
}

enum ViewInputKind {
  VIEW_INPUT_KIND_UNSPECIFIED = 0; // text
  VIEW_INPUT_KIND_TEXT = 1;
  VIEW_INPUT_KIND_SECRET = 2;
}

message ViewInput {
  ViewInputKind kind = 1;
  string value = 2;                // shown while the field is pristine; never set for SECRET
  string placeholder = 3;
  uint32 max_length = 4;
  string pattern = 5;
  string pattern_message = 6;
  bool mono = 7;
  bool has_value = 8;              // SECRET: a value is stored
}

message ViewOption {
  string key = 1;
  string value = 2;
  string label = 3;
  ViewInline description = 4;      // list style only
  bool disabled = 5;
}

enum ViewSelectStyle {
  VIEW_SELECT_STYLE_UNSPECIFIED = 0; // dropdown
  VIEW_SELECT_STYLE_DROPDOWN = 1;
  VIEW_SELECT_STYLE_LIST = 2;
}

message ViewSelect {
  repeated ViewOption options = 1; // at most 200
  repeated string value = 2;       // one unless multiple
  bool multiple = 3;               // implies LIST
  ViewSelectStyle style = 4;
  string placeholder = 5;
}

message ViewToggle {
  bool value = 1;
}

message ViewFormField {
  string key = 1;
  string name = 2;                 // payload key; command arg name
  string label = 3;
  ViewInline description = 4;
  string error = 5;
  bool required = 6;
  bool disabled = 7;
  ViewAction change = 8;           // event only
  oneof control {
    ViewInput input = 10;
    ViewSelect select = 11;
    ViewToggle toggle = 12;
  }
}

message ViewForm {
  repeated ViewFormField fields = 1;
  ViewButton submit = 2;           // event or command; event when a SECRET field exists
  repeated ViewButton secondary = 3;
  string error = 4;
  bool busy = 5;
  string reset_token = 6;
}

// The daemon → GUI stream for one instance (transport: ARCHITECTURE.md).
message PluginViewEvent {
  oneof event {
    PluginView snapshot = 1;       // first, after a resync, and on every render
    ViewLogAppend append = 2;
    PluginViewState state = 3;     // host-side states: loading, not responding, stopped
    StreamHeartbeat heartbeat = 4;
  }
}

message ViewLogAppend {
  string instance_id = 1;
  uint64 rev = 2;                  // the view rev it applies to; stale appends are dropped
  string key = 3;                  // a log node
  string text = 4;
}
```

### Decisions

**Replace, not patch (with one append op).** The plugin sends `surface/render` with the
whole view on every state change; `surface/append {instance, key, text}` extends one
log node.

* *Plugin authors* write `render(state) → tree` in any language with no diff
  bookkeeping, no ordering or resync logic: the last render is the truth. Patches
  (JSON Patch, keyed ops) would push the reconcile problem into every plugin.
* *Views are small.* Jenkins' biggest state is ~40 nodes / ~6 KB without the log; the
  wizard ~25 nodes. At ≤ 10 renders/s that is noise on loopback.
* *Focus and scroll survive replacement* because the GUI reconciles by `key` (stable
  across renders, so React keeps DOM nodes) and because input values are host drafts
  (below): a render cannot overwrite what the user is typing. Collapsed sections, log
  scroll position and the chip the user picked are host state keyed the same way.
* *Render cost stays local.* The GUI store normalises the tree by key and keeps a
  node's previous object when it is deep-equal (as `lib/mcp.ts` `shareMcp` does), so
  each node component's narrow selector (`byInstance[id].nodes[key]`) re-renders only
  nodes that changed. The daemon drops a render identical to the last (hash), so a
  plugin that re-renders on every poll costs the GUI nothing.
* *Logs are the exception.* Re-sending a 64 KB tail every 500 ms would re-decode and
  re-diff the string and, worse, replace the text node, which loses the user's text
  selection and scroll anchor on every tick. Appends add text nodes only. A render that
  sets the log's `text` replaces the buffer (new stage selected, new build).
* *Room to grow:* if views ever get large, the daemon can diff successive renders and
  send keyed patches to the GUI without changing the plugin protocol.

**Input values: local until submit.** Each field has a pristine/dirty state in the GUI.
Pristine fields show the plugin's `value` and follow its renders; once the user edits a
field it is dirty and keeps the draft regardless of renders until (a) the submit
succeeds (reply without error: every field turns pristine, so the plugin's next values
show), (b) the plugin changes `reset_token` or the field's `key`, or (c) Escape. A
`change` action (selects, toggles: at once; text inputs: debounced 300 ms, coalesced)
tells the plugin about an edit without making the plugin the owner. Drafts live for the
instance (tab switches keep them; `surface/close` drops them).

**Pending.** Two layers, same look. *Host pending* is automatic and per element: a
button from click until the plugin's reply (event) or `Invoke`'s return (command); a
form from submit until the reply (all of its fields and buttons). Renders the plugin
sent before its reply are applied before pending clears, so a field error never flashes
an enabled form first. *Plugin busy* (`button.busy`, `form.busy`) keeps it pending for
work that outlives the reply. A reply that does not come in 30 s clears pending with a
red toast "<plugin> did not answer"; `open_url` and `copy` have no pending.

**Limits** (the daemon validates every render; a violating render is refused with a
JSON-RPC error naming the rule, the previous view stays, and the plugin's log records it):

| Limit | Value |
|---|---|
| nodes per view (rows, chips, pairs, fields, options, buttons count) | 400 |
| nesting depth (section > section > node) | 3 |
| encoded view, logs excluded | 256 KB |
| string: label / title | 200 chars |
| text content | 4 KB |
| markdown | 16 KB |
| notice detail | 2 KB |
| log buffer kept by the host, per log node | 2,000 lines or 256 KB, head trimmed |
| log text in one render, one append | 64 KB |
| log nodes per view | 4 |
| renders per instance | coalesced to 10/s (latest wins) |
| appends per instance | batched per 100 ms |
| event `data` | 1 KB |
| form payload | 64 KB |
| buttons: header 2, row 3, notice 3, section 2, empty 2, actions bar 6; primary 1 per view | – |

---

## C. Events to the plugin

JSON-RPC from the daemon over the plugin's stdio. `instance_id` identifies one surface
instance: `<plugin>/<surface>/<scope>`, where the manifest declares the surface's scope
kind and the host fills the id: `global`, `thread:<session id>`, `project:<repo id>`,
`worktree:<path>`, `pr:<owner>/<repo>#<n>` (Jenkins could pick `pr`, so two threads on
one PR share a view and one poller). The context object (thread, repo, worktree, branch,
PR, and the values the availability predicate matched, such as the Jenkins URL) is
defined in `ARCHITECTURE.md`; events carry it so a plugin never has to remember it.

| Method | Kind | Params | Reply |
|---|---|---|---|
| `surface/open` | request | `{instanceId, surface, context}` | the first `PluginView` (5 s; else the host shows "not responding" with a restart command) |
| `surface/visibility` | notification | `{instanceId, visible}` | – |
| `surface/event` | request | below | `{toast?}` or a JSON-RPC error (red toast with its message) |
| `surface/close` | notification | `{instanceId, reason: tab_closed \| idle \| context_gone \| unavailable \| shutdown}` | – |

And from the plugin: `surface/render {instanceId, view}` and `surface/append
{instanceId, key, text}` (notifications, any time after `open` until `close`).

`surface/event` params:

```json
{
  "instanceId": "jenkins/pipeline/pr:acme/payments-api#4821",
  "surface": "pipeline",
  "eventId": 1043,
  "rev": 17,
  "kind": "click",
  "nodeKey": "chip-deploy",
  "action": "stage",
  "data": "deploy",
  "field": "",
  "values": {},
  "context": { "threadId": "01JA…", "repoId": "payments-api", "pr": { "number": 4821 } }
}
```

| kind | Sent when | `values` |
|---|---|---|
| `click` | a button, row or chip with an `event` action | – |
| `submit` | a form's submit with an `event` action (after host validation) | every field by `name`: string, bool (toggle), string array (multiple); secrets as strings |
| `change` | a field with a `change` action was edited | every non-secret field (the draft state), `field` names the one that changed |

Command actions do not produce surface events: the host invokes the command (with
`values` as args for a command submit), the daemon forwards `Invoke` to the plugin
(ARCHITECTURE.md), and the command's result is the reply.

**Host guarantees**

* **Lifecycle order per instance:** `open` → (`visibility` true/false, alternating,
  starting hidden) → `close`. No event, visibility or close before `open` has been
  answered; nothing after `close` until a new `open` (the same id may reopen). `open`
  happens when a viewer first needs the instance (a tab mounts, `code-foundry plugin
  view`); `visible` while at least one viewer shows it (active tab, window visible);
  `close` when its tab closes, after 10 min hidden (`idle`), when the context goes
  (thread archived or removed, PR closed), when availability turns false, or on daemon
  or plugin shutdown.
* **Ordering:** events of one instance reach the plugin in the order the user caused
  them; there is no order across instances. Events are not serialised behind replies (a
  slow click does not hold back the next one), and `change` events are coalesced (only
  the latest edit per field is sent).
* **At most once:** the host never retries. If the plugin crashes or restarts with
  events in flight, they fail (pending clears, red toast); the plugin gets a fresh
  `open` for each instance a viewer still shows. Destructive work belongs in commands
  with `Confirm`, and plugins should make actions idempotent where they can.
* **Ids:** `eventId` grows per daemon run (dedupe and log correlation); `rev` is the
  view the user acted on (a click on "Abort" in rev 17 after rev 18 started build 483 is
  detectable; put the build in `data` or the command args anyway); `nodeKey` is the
  element's key; `instanceId` is stable for its scope across GUI reconnects and plugin
  restarts.
* **Secrets:** sent only in `submit`, never in `change`, never logged or persisted by
  the daemon, never echoed into a view.
* **Cached views:** the daemon keeps each instance's last view; a remounting tab shows
  it at once (dimmed with "Updating…" if the plugin restarted since), then the next
  render replaces it.

---

## D. Walkthrough

JSON uses the shorthands (short enums, bare strings for inline). Views are abbreviated
only where a pattern repeats (`…`).

### Jenkins pipeline tracker (scope `pr`, available when a check links Jenkins)

**Running**

```json
{
  "header": {
    "icon": "workflow", "title": "#4821 Retry token refresh on 401",
    "pill": { "label": "Running" },
    "subline_icon": "clock",
    "subline": { "spans": [
      { "text": "payments-api #482", "mono": true, "url": "https://jenkins.acme/job/payments-api/482/" },
      { "text": " · " }, { "time": { "at": "2026-10-14T14:01:10Z", "style": "elapsed" } } ] },
    "actions": [ { "key": "refresh", "label": "Refresh", "icon": "refresh-cw", "iconOnly": true, "action": { "event": "refresh" } } ],
    "tabTitle": "Jenkins #482"
  },
  "nodes": [
    { "key": "stages", "chips": { "chips": [
      { "key": "chip-checkout", "label": "Checkout", "status": "ok", "meta": "12s", "action": { "event": "stage", "data": "checkout" } },
      { "key": "chip-build", "label": "Build", "status": "ok", "meta": "1m 40s", "action": { "event": "stage", "data": "build" } },
      { "key": "chip-test", "label": "Test", "status": "running", "selected": true,
        "meta": { "spans": [ { "time": { "at": "2026-10-14T14:03:02Z", "style": "elapsed" } } ] } },
      { "key": "chip-deploy", "label": "Deploy", "status": "pending" } ] } },
    { "key": "log", "log": { "title": "Test · log", "truncated": true, "text": "…\n[INFO] Tests run: 412, Failures: 0\n" } },
    { "key": "acts", "actions": { "buttons": [
      { "key": "abort", "label": "Abort", "icon": "square", "style": "destructive",
        "action": { "command": { "name": "plugin.jenkins.abort", "args": { "job": "payments-api", "build": "482" } } } },
      { "key": "open", "label": "Open in Jenkins", "icon": "external-link", "action": { "openUrl": "https://jenkins.acme/job/payments-api/482/" } } ] } }
  ]
}
```

Then `surface/append {"key": "log", "text": "[INFO] Running AuthRetryTest\n"}` as lines
arrive; a click on the Build chip renders a view whose `log.text` is Build's tail.

**Failed** (changes from Running)

```json
"pill": { "label": "Failed", "tone": "error" },
"subline": { "spans": [ { "text": "payments-api #482", "mono": true, "url": "…" }, { "text": " · failed after 6m 02s" } ] },
"nodes": [
  { "key": "stages", "chips": { "chips": [ "… checkout ok, build ok, test ok 3m 11s …",
    { "key": "chip-deploy", "label": "Deploy", "status": "failed", "meta": "48s", "selected": true } ] } },
  { "key": "why", "notice": { "tone": "error", "title": "Deploy failed",
    "detail": "Error: UPGRADE FAILED: timed out waiting for the condition (helm, 5m0s)" ,
    "actions": [ { "key": "send", "label": "Send failure to Claude", "icon": "send", "style": "attention",
      "action": { "command": { "name": "plugin.jenkins.send-failure", "args": { "build": "482", "stage": "deploy" } } } } ] } },
  { "key": "log", "log": { "title": "Deploy · last 200 lines", "truncated": true, "noFollow": true, "text": "…" } },
  { "key": "acts", "actions": { "buttons": [
    { "key": "rebuild", "label": "Rebuild", "icon": "rotate-ccw", "action": { "command": { "name": "plugin.jenkins.rebuild", "args": { "build": "482" } } } },
    { "key": "open", "label": "Open in Jenkins", "icon": "external-link", "action": { "openUrl": "…" } } ] } }
]
```

`send-failure` calls `thread.send` with the excerpt (bridge to the thread); the thread
attention ("Jenkins: deploy stage failed") is the thread-status contribution, not the
view.

**Succeeded**: pill `{"label": "Passed", "tone": "ok"}`, every chip `ok`, the log inside
`{"section": {"title": "Deploy · log", "collapsible": true, "collapsed": true, …}}`,
actions Rebuild + Open in Jenkins.

**Queued / no pipeline yet**

```json
{ "header": { "title": "#4821 Retry token refresh on 401", "pill": { "label": "Queued" },
    "subline": { "spans": [ { "text": "payments-api #483 · queued " }, { "time": { "at": "…", "style": "relative" } } ] } },
  "nodes": [
    { "key": "wait", "empty": { "glyph": { "status": "pending" }, "title": "Waiting for an executor",
      "body": "2 builds ahead of this one.",
      "actions": [ { "key": "open", "label": "Open in Jenkins", "icon": "external-link", "action": { "openUrl": "…" } } ] } } ] }
```

No pipeline yet: same `empty` with `glyph {icon: "workflow"}`, "No pipeline for this PR
yet", body "Jenkins starts one when the PR's checks report. Checking every 30s." and no
pill.

**Unreachable**

```json
{ "key": "down", "notice": { "tone": "error", "title": "Can't reach jenkins.acme",
  "body": { "spans": [ { "text": "Retrying in " }, { "time": { "at": "…", "style": "countdown" } } ] },
  "detail": "dial tcp 10.20.4.7:443: i/o timeout",
  "actions": [ { "key": "retry", "label": "Retry now", "icon": "refresh-cw", "action": { "event": "retry" } } ] } }
```

**Needs auth**

```json
[ { "key": "auth", "notice": { "tone": "attention", "title": "Jenkins needs an API token",
    "body": { "spans": [ { "text": "Create one under " }, { "text": "your Jenkins profile", "url": "https://jenkins.acme/me/configure" }, { "text": "." } ] } } },
  { "key": "token-form", "form": {
    "fields": [
      { "key": "f-user", "name": "user", "label": "Username", "required": true, "input": { "value": "awaumann", "mono": true } },
      { "key": "f-token", "name": "token", "label": "API token", "required": true, "input": { "kind": "secret", "pattern": "^[0-9a-f]{32,34}$", "patternMessage": "A Jenkins token is 32–34 hex characters." } } ],
    "submit": { "key": "save", "label": "Save token", "style": "primary", "action": { "event": "save-token" } } } } ]
```

(Event, not command: the form holds a secret.) A refused token comes back as
`fields[1].error: "Jenkins refused this token (401)"`.

### Enterprise data auth manager (scope `global`)

Header in every state: `{"icon": "key-round", "title": "Enterprise data", "pill": …}`.

**Not signed in**

```json
{ "key": "start", "empty": { "glyph": { "icon": "key-round" }, "title": "Sign in to Enterprise Data",
  "body": "Claude needs a token to query warehouse data. Sign in once and every new session gets it.",
  "actions": [ { "key": "signin", "label": "Sign in", "icon": "log-in", "style": "primary",
    "action": { "command": { "name": "plugin.entdata.sign-in" } } } ] } }
```

**Waiting for the browser**

```json
[ { "key": "hint", "text": { "content": "Enter this code in the browser window that opened:" } },
  { "key": "code", "text": { "content": "WDJB-MJHT", "size": "lg", "copyable": true } },
  { "key": "wait", "progress": { "label": "Waiting for the browser…",
    "meta": { "spans": [ { "text": "code expires in " }, { "time": { "at": "…", "style": "countdown" } } ] } } },
  { "key": "acts", "actions": { "buttons": [
    { "key": "reopen", "label": "Open the page again", "style": "link", "action": { "openUrl": "https://login.acme/device" } },
    { "key": "cancel", "label": "Cancel", "action": { "event": "cancel" } } ] } } ]
```

**Choose account / environment**

```json
{ "key": "choose", "form": {
  "fields": [
    { "key": "f-env", "name": "env", "label": "Environment", "required": true,
      "select": { "style": "list", "value": ["prod"], "options": [
        { "key": "o-prod", "value": "prod", "label": "Production", "description": "Read-only warehouse, all regions" },
        { "key": "o-stg", "value": "staging", "label": "Staging", "description": "Refreshed nightly from production" } ] } },
    { "key": "f-acct", "name": "account", "label": "Account", "required": true,
      "select": { "value": ["analytics-ro"], "options": [
        { "key": "o-a1", "value": "analytics-ro", "label": "analytics-ro" }, { "key": "o-a2", "value": "payments-ro", "label": "payments-ro" } ] } } ],
  "submit": { "key": "go", "label": "Continue", "style": "primary",
    "action": { "command": { "name": "plugin.entdata.configure" } } },
  "secondary": [ { "key": "back", "label": "Use a different login", "style": "link", "action": { "event": "restart" } } ] } }
```

(Command submit: `code-foundry plugin entdata configure --env prod --account
analytics-ro` does the same from the CLI.)

**Configuring**

```json
[ { "key": "prog", "progress": { "value": 0.5, "label": "Configuring…", "meta": "2 of 4" } },
  { "key": "steps", "list": { "dense": true, "glyphStyle": "icon", "rows": [
    { "key": "s1", "glyph": { "status": "ok" }, "title": "Exchanged the browser sign-in for a token" },
    { "key": "s2", "glyph": { "status": "ok" }, "title": "Fetched warehouse role" },
    { "key": "s3", "glyph": { "status": "running" }, "title": "Writing the MCP server entry" },
    { "key": "s4", "glyph": { "status": "pending" }, "title": "Checking query access" } ] } } ]
```

**Signed in**

```json
"pill": { "label": "Signed in", "tone": "ok" },
"nodes": [
  { "key": "who", "pairs": { "items": [
    { "key": "p-acct", "label": "Account", "value": { "spans": [ { "text": "alex@acme.com", "mono": true } ] } },
    { "key": "p-env", "label": "Environment", "value": "Production · analytics-ro" },
    { "key": "p-exp", "label": "Expires", "value": { "spans": [ { "time": { "at": "…", "style": "relative" } } ] } } ] } },
  { "key": "inj", "section": { "title": "Added to new sessions", "children": [
    { "key": "inj-list", "list": { "dense": true, "rows": [
      { "key": "e1", "title": "ENTDATA_TOKEN_FILE", "titleMeta": { "spans": [ { "text": "~/.entdata/token", "mono": true } ] }, "trailing": "env" },
      { "key": "e2", "title": "ENTDATA_ENV", "titleMeta": "prod", "trailing": "env" },
      { "key": "m1", "title": "entdata", "titleMeta": "stdio", "trailing": "MCP server" } ] } },
    { "key": "inj-note", "text": { "size": "sm", "content": "Running threads pick it up when they reconnect." } } ] } },
  { "key": "scope", "section": { "title": "Projects", "children": [
    { "key": "scope-form", "form": { "fields": [
      { "key": "f-all", "name": "all", "label": "All projects", "toggle": { "value": false }, "change": { "event": "scope" } },
      { "key": "f-proj", "name": "projects", "label": "Only these", "change": { "event": "scope" },
        "select": { "multiple": true, "value": ["payments-api"], "options": [
          { "key": "o-p1", "value": "payments-api", "label": "payments-api" }, { "key": "o-p2", "value": "ledger", "label": "ledger" } ] } } ] } } ] } },
  { "key": "acts", "actions": { "buttons": [
    { "key": "refresh", "label": "Refresh token", "icon": "refresh-cw", "action": { "command": { "name": "plugin.entdata.refresh" } } },
    { "key": "signout", "label": "Sign out", "icon": "log-out", "style": "destructive", "action": { "command": { "name": "plugin.entdata.sign-out" } } } ] } }
]
```

Expiring within a day: pill `{"label": "Expires soon", "tone": "attention"}` and a
`notice{tone: attention}` with Refresh as its `attention` button.

**Error**

```json
{ "key": "err", "notice": { "tone": "error", "title": "Sign-in failed",
  "body": "The identity provider rejected the code.",
  "detail": "invalid_grant: device code expired (request 7f3a…)",
  "actions": [
    { "key": "retry", "label": "Try again", "icon": "rotate-ccw", "style": "attention", "action": { "command": { "name": "plugin.entdata.sign-in" } } },
    { "key": "copy", "label": "Copy details", "icon": "copy", "action": { "copy": "invalid_grant: device code expired (request 7f3a…)" } } ] } }
```

### What was awkward

1. **Blue Ocean's graph flattens.** Parallel stages become consecutive chips; branches
   and the connecting lines need the iframe tier (or a later `chips.groups`).
2. **Ticking times** forced the `time` span; without it the running build would need a
   render per second just for "elapsed". With it, durations of finished stages are still
   plain text the plugin formats, so the two can drift in style (host could expose a
   `duration` span later).
3. **Project scope** needs the project list; the plugin must subscribe to the `repo`
   source and render options itself. A host-filled option source (`options_source:
   projects`) would be simpler and always current (open question 7).
4. **Log highlights**: the failing line can only be called out in the notice above the
   log; per-line tones or ANSI colours are deferred.
5. **Send failure to Claude** is a command whose payload (the excerpt) lives in the
   plugin; fine, but whether it sends at once or drafts into the composer is a product
   call (open question 4).
6. **Wizard "Back"** has no host support: the plugin keeps its own step history and
   re-renders. Acceptable; it is what server-driven UI means.
7. **One global view, many panels.** The auth surface shows under any selection; since
   its scope is `global`, every panel shares one instance and one draft state, which is
   right but means a draft typed under thread A appears under thread B.

---

## E. Open questions for Alex

1. **Success colour.** Keep emerald for `ok` pills and status glyphs (as MCP
   "Connected" and PR checks already do), or neutral everywhere in plugin surfaces?
2. **Header icon colour.** Neutral for every plugin (proposed), or let a plugin pick an
   identity hue from a fixed set as MCP (amber plug) and Workspace (violet layers) do?
   Amber as identity collides with "needs you".
3. **One filled primary button per view** for wizard steps and form submits, or muted /
   outline only as elsewhere in the panel?
4. **"Send failure to Claude"**: send at once through `thread.send`, behind a confirm
   showing the excerpt size, or drop it into the thread's composer as a draft?
5. **ANSI colours in logs** in v1 (Jenkins AnsiColor output, terminal palette), or strip
   until someone asks?
6. **Tab status.** Should a plugin's tab in the strip show an amber/red dot when its view
   says so (a failed pipeline in a background tab), or is the thread's attention status
   enough?
7. **Host-filled options** (projects, worktrees, threads) for selects, or plugins
   subscribe and render the list themselves?
8. **Secret input in v1.** Jenkins tokens need it; should the host store secrets in the
   Keychain on the plugin's behalf instead of handing them to the plugin to keep?
9. **Surface hotkeys.** Plugin tabs get no panel letter in v1 (collisions with M, W, T,
   L …); OK, or a manifest-requested letter granted first come first served?
10. **Toasts only in reply to the user's action** (proposed), or may a plugin raise one
    on its own (a build finished while the tab is visible)?
11. **Lenient JSON** (short enum names, bare strings for inline) in the daemon's
    decoder, or strict protojson plus SDK constants?

### What the iframe tier would add

A surface may declare `ui: "iframe"` and ship static assets the daemon serves under
`/plugins/<name>/` on the loopback listener (own origin per plugin path is not possible
on one port, so: `sandbox="allow-scripts"` without `allow-same-origin`, a strict CSP,
no daemon token in the frame). The host passes theme tokens (the CSS variables of both
schemes, current scheme, font stacks) and the instance context by `postMessage`, and
relays a narrow bridge: render-free `event`, `command` (same grants as the view model),
`open_url`, `copy`, and a resize request. It buys custom rendering (pipeline graphs with
parallel branches, charts, drag and drop, canvases) at the cost of keyboard and focus
integration, design-rule enforcement and the CLI text rendering, which only the
declarative tier gives. A surface could mix both later (a `frame` node inside a
declarative view), but v1 keeps them apart.
