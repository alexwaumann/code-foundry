# User themes: follow-ups (2026-10-22)

The known follow-ups of the user themes series (#328 files and ThemeService, #329 hardening,
#330 the editor, #331 the model flow; theme-model-flow.md "Left out" and "Gotchas"). Four
items: the model gets the contrast report, the Ask context leaves the bubble, a card saved
without applying gets Apply, and a save that repaints nothing no longer toasts.

## 1. The contrast report reaches the model

The daemon still derives no colour. The GUI measures and tells it:

- **Version.** `UserTheme.version` (field 11): `theme.File.Version()`, the first 16 bytes of
  the SHA-256 of the file as the daemon writes it (`Marshal`), hex. Set by `theme.ToProto`, so
  ThemeService's snapshot and a card's theme carry it. The GUI keeps it on `UserThemeFile`
  (`readUserThemeFile(json, path, version)`); the localStorage copy has none, so nothing is
  reported until the daemon's list arrives.
- **Publish.** `UiService.PublishThemeReport({reports: [ThemeReport{id, version, issues:
  [ThemeContrastIssue{slot, against, label, ratio, required}], stale: [ThemeStalePin{slot,
  pinned, basis, derived}]}]})`. `lib/themeReports.ts` (`startThemeReports`, App.tsx beside
  `startThemePublish`) watches the user themes; each new `(id, version)` is resolved and
  measured once (`themes/report.ts reportOn`: `contrastReport` + `staleOverrides`), sent after a
  150 ms debounce in one batch, and every report goes again on each (re)connect
  (`onDaemonConnect`, now exported from lib/theme.ts). A failed publish is logged; the next
  connect resends.
- **Keep.** `theme.Reports` (internal/theme/report.go), in memory, last report per id, at most
  1024 ids (the oldest goes). `Report.Check` refuses a bad id, a non-hex version, a name that is
  not a slot, a label over 256 bytes or with control characters, a ratio outside 1..21, a
  stale colour that is not lowercase hex, more than 1024 issues or 256 stale pins; a refused
  report refuses its whole batch (InvalidArgument). `Wait(ctx, id, version)` wakes on every
  publish.
- **Print.** `theme save` (and `theme duplicate`) insert the check after `pinned:`, then wait
  up to `DefaultThemeReportWait` (1.5 s) for the report on the version just written:
  - `contrast: ok`, or `contrast: 2 issues — warning-text on warning-surface over surface
    3.9:1 (needs 4.5), …` (the first six; then `and N more (theme check <id> lists every one)`;
    `--cf-` dropped; ratios rounded down as the editor's `ratioText`), then
  - `stale pins: 0`, or `stale pins: 1 — sidebar-row-selected (pinned #2a2b3c when its rule gave
    #272739; it gives #292a3d now)`.
  - `contrast: not checked (the app is not open)` with no app window (no wait);
    `contrast: not checked yet (…; theme check <id> in a moment)` when a window is open but no
    report came in time; from the app itself (the editor's Save, ActiveView set) no wait and
    `contrast: shown in the Themes page's editor`.
  - JSON: `ThemeSaved.contrast` (`ThemeCheck{id, version, checked, reason, issues, stale}`).
  The wait comes last, after the card and the toast, so neither waits on it.
- **`theme.check <id>`** (commands_theme_check.go, Settings, NoKeybinding, the user's ids):
  `<Name> (<id>), a <scheme> theme`, then every failing pair on its own line and the stale
  line; the same wait for the current version.
- **Skill.** "Making a theme" (still 6 lines; SKILL.md stays at its 80-line cap): the save
  prints `contrast:`; fix each failing pair in the base first, pin only where that cannot,
  drop stale pins, save the id again, `theme check <id>` re-reads. THEMES.md (the help skill's
  reference) says the same and points "Checking a theme" at `theme check` before
  `pnpm run themes:check`. `daemon.capabilities --group rendering`'s themes line names it.
- The card's footer (`N pinned · contrast ok | N contrast issues`) is unchanged.
- Mock: `publishThemeReport`, the version hash, the save's wait and lines, `theme.check`;
  `GET /__mock/themes` lists the reports.

### Stale pins outside the editor

The editor's stale rule needs what a pin was made against, which is session state (the
editor records it at open and at pinning). For the report the basis is carried from version to
version of the file (`carryPinBasis`): a pin kept at the same value keeps its basis, so a base
change since then shows it stale; a new or changed pin is measured on the version it appears
in (not stale). With no earlier version every pin starts clean, as the editor does at open.
The bases live in localStorage (`cf.themes.pinBasis`), pruned to the themes that exist, so a
relaunch and every window compute the same report.

## 2. theme.ask's context leaves the bubble

`CreateThreadRequest.system_prompt_append` (field 24) → `CreateOptions.SystemPromptAppend` →
`Thread.SystemPromptAppend` from the first spawn: the per-thread append a reseed or Ember's
seed uses (after ThreadPrompt, the workspace line and the app memory; 64 KiB, no NUL, as
`cleanSeed` checks; persisted on the row). The app memory's path is the same `systemPrompt`.
`theme.ask` sends:

- `InitialPrompt` = the user's words alone (`ThemeAskMessage`); with `--pair`, `Make a light
  pair for my theme <Name>.` first, then their words if any.
- `SystemPromptAppend` = `ThemeAskContext`: where they asked (the Themes page or not), the
  current slots, what to do (`theme save --data - --apply`, keep refining, the skill
  section) and, for a pair, `ThemePairAsk`'s instruction (`theme show`, the pair id, pair both
  ways, apply), now in the third person.

The bubble and the provisional name are the user's words. While the naming model runs, the
sidebar row and the header show that first line in italics ("a dark theme that feels like a
tid…"); in this environment the naming model failed (a 1M-context usage-credits error from
`claude -p`), so the provisional name stayed, which is the fallback anyway.

## 3. Apply on a card saved without applying

`ThemeCard`: when the item is not applied, the card reads its scheme's slot
(`useSettingValue`); while the slot is on another theme it shows **Apply** (a primary xs
button, the check icon) before Edit, which runs `theme.set-<scheme> <id>`
(`stores/themeCards.ts applySavedTheme`, the same quiet runner Undo uses). Once the slot is on
the theme, by this Apply or any other way, the card shows the "applied" badge and no Apply;
if the slot moves off it, Apply comes back. Disabled once the theme is deleted. No toast (a
GUI `theme.set-*` never toasts) and no Undo on such a card.

## 4. No second toast for a save that repaints nothing

`theme.save` from a thread reads the theme's file before the save. The card still says
applied when `--apply` was given or the slot already had the theme; the toast now needs the
slot to change (`before != id`), a theme new to the directory, or new colours
(`theme.SameColours`: scheme, base and overrides; name, pair, from, source and created_by do
not count). A pair-only re-save adds its card and shows nothing. `showThemeCard` takes the
toast decision separately. The mock does the same.

## Verified

- `make check` green. New tests: Go `TestReportCheck` (table), `TestReportsPublishWait`,
  `TestReportsKeepTheNewest`, `TestFileVersionAndSameColours` (table), `TestUIPublishThemeReport`,
  `TestThemeSaveContrast` (table: no app, ok, issues + stale, many, a slow report, no report,
  from the editor; a fake GUI that reports on each version), `TestThemeCheck`,
  `TestCreateSystemPromptAppend`; `TestThemeSaveCardAndToast` gains the recolour, pair-only and
  apply-later cases; `TestThemeAsk` checks the bare message and the append. Frontend
  `lib/themeReports.test.ts` (report shape, carried basis and stale, one publish per version,
  all on connect, unversioned themes skipped). e2e (`theme-model-flow.spec.ts`, mock): Apply
  on an unapplied card, and the save's contrast line, `theme check`, the fix and a pair-only
  save that toasts nothing; `user-themes.spec.ts` and `theme-editor.spec.ts` still pass.
- Built app (`make gui-build`) on an isolated `CODE_FOUNDRY_HOME`, worktree `bin` first on
  `PATH`, no inherited `CLAUDE*` / `CODE_FOUNDRY_*` variables:
  - CLI with no window: `contrast: not checked (the app is not open)`. With the window open,
    two PublishThemeReport calls at connect, `theme check` listed 5 failing pairs of a file
    pinning `--cf-warning-text` to the surface, a fixed save printed `contrast: ok` in about
    0.18 s, and a base change under a kept pin printed the stale line.
  - `theme.ask` from the Themes page's context (CommandService.Invoke over the socket with
    `activeView: themes`), `claude-haiku-5-5[1m]`, medium, auto. The spawn's
    `--append-system-prompt` ended with the theme context; the bubble was the description only.
    Haiku loaded the skill, read the reference, wrote Tide Pool Night, saved with `--apply`:
    `contrast: ok` / `stale pins: 0`. It then searched the disk for `slots.ts` to learn how the
    sidebar derives (for "quieter sidebar", not for contrast), moved the canvas and saved again
    (ok). Asked to pin the warning text to `#4a4410`, its save printed `contrast: 5 issues —
    warning-text on surface 1.82:1 (needs 4.5), …` and it told the user each failing pair and
    offered a lighter olive instead of leaving it. A second ask (`--pair`, light scheme): the
    bubble read "Make a light pair for my theme Tide Pool Night." and the user's words; Haiku
    ran `theme check` on its own, saved the pair (`contrast: ok`), re-saved the dark theme with
    `pair` (its 5 issues printed again) and said those issues predate the change.
  - The card's Apply and the applied badge in the Wails window, dark and light (shots in the
    PR body). The window takes no synthetic clicks here (no accessibility permission), so the
    click was driven in the e2e; in the window the slot was set with `theme set-light`, which
    is what Apply runs.
  - No ERROR lines; the only WARN was the naming model's. Afterwards the slots and scheme were
    put back, the scratch themes deleted (so the shared WebKit storage holds none), both test
    transcripts removed and the home deleted.

## Left out

- The pin bases are per machine (localStorage): a theme first seen after several saves starts
  clean, so a pin that went stale before the app saw the theme is not flagged.
- With several windows open, each publishes the same reports (last writer wins, as with
  PublishTheme).
- Haiku still went to the source for how the sidebar is derived; THEMES.md lists the slots but
  not the sidebar's rule. Not a contrast problem, so not in this PR.
- The card's swatches still show the base, not resolved slots or pins.

## Daemon restart

Needed: the RPC, the report store, theme save's output, `theme.check`, theme.ask's system
prompt and the skill (written at daemon start). GUI and daemon ship together.
