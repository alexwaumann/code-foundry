# Update dialog redesign (frontend)

Branch `cf/update-dialog-ui`. Replaces the Software Update dialog and the sidebar's
underlined update text with the approved mockups (option B, round 3). The backend half
(`app.restart` in the daemon, the host relaunching after the daemon exits) is a separate
branch; this one only touches `gui/frontend/`.

## Decisions

* **One Restart action.** The old dialog had two buttons (Relaunch for the window,
  Restart daemon for the daemon) and a separate confirm dialog. Now there is one
  "Restart Now" that invokes `app.restart` with `confirmed: true`: the dialog itself is
  the confirmation, so `invokeConfirmed`'s confirm dialog is skipped. On success the
  dialog switches to "Restarting…" and stays open; the host relaunches the window.
  `app.relaunch` and `daemon.restart` stay as palette/CLI commands (the palette's
  `daemon.restart` still confirms), but the dialog no longer offers them.
* **Old daemon fallback.** When `app.restart` is not in the command list (or Invoke says
  NotFound because the list had not loaded), Restart Now runs `daemon.restart` with
  `confirmed: true` and then calls the Wails host's `Relaunch` binding directly
  (`relaunchApp()` in `src/api/app.ts`; a no-op outside Wails).
* **Busy-only thread list.** Only threads that are mid-turn (live and status busy) are
  named, under an amber "N threads are still working" header. Open but idle threads are
  only counted in the body ("3 threads are open but none are working…"): they reconnect
  with their history, so listing them adds nothing.
* **No × except "up to date".** Every other state has a muted link that closes (Later,
  "Wait, I’ll restart later", Hide, Not now). The disabled-build state also has a ×,
  since it has no link.
* **Chip in the sidebar.** The status row's indicator is a 22px tinted chip: icon,
  label, right-aligned muted call to action. Sky for available/installing, red for
  failed, emerald for installed / restart required / partly applied (all "vX installed ·
  Restart to apply", since one restart fixes all three).
* **Pure view model.** `updateView(status, guiVersion, {live, busy}, restarting)` in
  `src/lib/update.ts` picks the variant and the copy; the component maps variants to
  primary buttons and meta lines through registries. Table tests in `update.test.ts`.
* Typographic apostrophes (’) and ellipses (…) as in the mockups; tests match them.

## Variants

| variant | when | title | primary | link | meta |
|---|---|---|---|---|---|
| readyIdle | installed/restartRequired, 0 live | Code Foundry vX is ready | Restart Now | Later | Running vY · Release notes |
| readyBusy | same, ≥1 busy | Code Foundry vX is ready (+ busy box) | Restart Now | Wait, I’ll restart later | Running vY · Release notes |
| readyOpen | same, live > 0, none busy | Code Foundry vX is ready | Restart Now | Later | Running vY · Release notes |
| available | available | Code Foundry vX is available | Install vX | Later | Checked … · Release notes |
| installing | downloading | Installing vX… (bar + last progress line) | none | Hide | none |
| upToDate | idle, versions agree | You’re up to date / Checking for updates… | Check Again (outline) | × | Checked … · github.com/owner/repo |
| partlyApplied | idle with GUI ≠ daemon, or installed/restartRequired with GUI = target | Code Foundry vX is partly applied (+ busy box when busy) | Restart Now | Later / Wait… | App vA · Daemon vD |
| failed | failed | Couldn’t install vX (red callout + reason) | Try Again | Not now | none |
| restarting | Restart Now succeeded | Restarting… (bar) | none | none | Stopping daemon |
| disabled | `!enabled` | Updates are off for this build | none | × | none |

Precedence: restarting, disabled, partlyApplied, then the daemon's state.

Test ids: `update-dialog` (with `data-state-name` = daemon state and `data-variant`),
`update-state` (title), `update-install`, `update-restart`, `update-check`,
`update-later`, `update-close` (×), `update-notes`, `update-progress`, `update-failure`,
`update-error`, `update-check-error`, `update-busy-threads` (`update-busy-heading`,
`update-busy-thread`), `update-meta`; chip: `update-indicator` (`data-kind` available,
downloading, failed, installed), `update-indicator-label`, `update-indicator-cta`.

## Gotchas

* `guiVersion` is null outside Wails (browser dev, e2e), so partly applied never shows
  there; its copy is covered by the unit tests only.
* Partly applied also covers the daemon being *newer* than the window (the daemon was
  restarted from the CLI): "The daemon is on vX but the app is still on vY". Restart Now
  relaunches both.
* The mock's s-1 flips busy/idle every 4s. e2e parks it in needs-attention (that sticks)
  and adds busy threads with `POST /__mock/threads?status=busy` for stable counts.
* The mock registers `app.restart` (confirmed; comes back as the installed version, like
  `daemon.restart`) and counts runs in `GET /__mock/update` (`restarts`).
* In the fallback path `daemon.restart` returns before the old daemon has exited; the
  relaunched window relies on the host's connect/auto-start retry to reach the new one.
* Busy names come from a `useShallow` selector over `order`/`byId`, so the dialog only
  re-renders when the busy list actually changes.
* "Restarting…" resets when the dialog closes (Escape still works, in case the host
  never relaunches, e.g. in the browser).
