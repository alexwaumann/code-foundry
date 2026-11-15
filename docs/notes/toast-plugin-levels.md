# Plugin and daemon toast levels (PR 2 of 3)

PR 1 (docs/notes/toast-levels.md) gave every app toast a level, a short title and an
optional description. This one gives the same to toasts that come from outside the
frontend: a plugin's `view/toast` and the daemon's notify intent. Purely additive.

## Plugins

- `view/toast` takes `level: success` and an optional `description`. The existing `text`
  is the title: no rename, no alias, no fallback to the plugin's name.
- SDK: `pluginsdk.ToastSuccess`, `ToastParams.Description`, and `h.ToastWith(ToastParams)`
  for a toast with a description (the `SetContext(ContextParams)` /
  `ReadTerminalWith(…Options)` style). `Toast` and `ToastIn` keep their signatures.
- Host (`internal/store/plugin/toast.go`): `cleanToast` trims both, cuts the text at 200
  runes and the description at 500, makes an unknown level info, and drops a toast with no
  text (a description alone is not a toast). Same one-a-second rate limit.
- A toast without an instance (`Toast`) becomes the notify intent. Without a description
  it is unchanged: the plugin's display name is the title, the text under it. With one, the
  text is the title and the description under it, like every other toast; the plugin's name
  is then not on it. Keeping the name would need a third line or a source field on the
  intent, and only `ToastWith` callers who chose a description see the difference.
- The host announces `view.toast.description` (also in plugintest's `HostCapabilities`).
- GUI: `api/plugin.ts` keeps the plugin's level words (`success|info|attention|error`, an
  unknown one info) and the description; `stores/pluginSurfaces.ts`' `pluginToastNotice`
  maps attention to warning and passes the description.
- `plugin surface` (CLI, watching) prints `toast <level>: <text> — <description>`.

## Daemon notify intent

- `UiIntent.Notify.Level` gains `LEVEL_SUCCESS = 4`; `api/ui.ts` maps it, and maps a level
  this build does not know to info (an older window on a newer daemon).
- `ui.notify --level` takes `success`.
- Moved to success: the app memory's "Remembered: …" and "Forgot: …" (a thread changed the
  memory; the thread is often not on screen, and the toast is the only sign).
- Left info: a thread's "<theme> applied to <scheme>" (`commands_theme_card.go`). It carries
  Undo and the whole app has just recoloured, so it reads as a heads-up with a way back more
  than a confirmation. The lead's call.
- The plugin toast without an instance follows the plugin's level (success included).

## Compatibility

| Case | What happens |
|---|---|
| Old plugin, new app | Unchanged. The wire shape has no new required field; `ToastParams` marshals without `description` when empty (`TestToastParamsWire`). Checked end to end: main's hello binary on this daemon and GUI shows "note saved" as the same info card. |
| New SDK plugin, older app (every release so far, v0.21.7 and the v0.22 tips) | Not rejected. The old host's `json.Unmarshal` drops the unknown `description`, and its level check turns `success` into `info`. `ToastIn` shows the text as an info toast; `Toast`/`ToastWith` without an instance shows the plugin's name over the text, as before. So the text has to read right on its own. |
| New daemon, older GUI window | `SurfaceToast.level = "success"` and `LEVEL_SUCCESS` are unknown to the old mapping and show as info; the description is ignored. |

Since nothing is rejected, the SDK does not degrade on its own (no host-version guessing).
A plugin that wants a different fallback checks `h.HasCapability("view.toast.description")`.

## Example plugin

hello's confirmations are success now and read as titles: "Sent to the assistant", "Sent
to the thread", "Note saved" (with "On build #N" as its description, through `ToastWith`),
"Saved", "Build #N queued again", "Build #N aborted". The chart bar's "Build #N" stays info
(it stands in for opening something, not a confirmation). The mock (`mock/plugins.ts`)
mirrors it, and its memory toast and `ui.notify` levels follow the daemon.

## Guidance (skill: reference/host-api.md, protocol.md)

The text is the title, so keep it short; detail goes in the description. Success sparingly:
feedback for an act belongs where it happened, and a success toast is for when that place is
gone (the result lands elsewhere) or for background work that finished.

## Gotchas

- In the headless WebKit drive, every toast (a plain `ui notify` too) closed within about a
  second, not the Toaster's 4 s; hovering the toast holds it for a screenshot. Not seen in
  the app; not this change.
- `plugin dev` refuses a folder outside the home directory, so an old plugin build is tried
  by swapping `plugins/examples/hello/bin/hello` (gitignored) and `plugin restart hello`.

## End to end (2026-11-14)

`make build plugins`, `make drive DAEMON=dev DRIVE_HOME=/tmp/…`, then with drive.env
sourced: `plugin dev plugins/examples/hello`, `thread new --no-project`, `plugin hello show
demo --context-thread <id>`; in the GUI, Runs › Build #4 › Save note showed a success toast
"Note saved / On build #4". `CODE_FOUNDRY_THREAD=<id> code-foundry memory add …` showed the
success "Remembered: …" with Show in Settings, `memory remove` the success "Forgot: …".
