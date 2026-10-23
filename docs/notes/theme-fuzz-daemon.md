# Theme fuzz fixes: daemon, verbs and the model flow (2026-10-22)

Fixes for two fuzz reports on the user themes series (#328-#332): "files" (the theme files,
store, verbs, settings and stylesheet) and "model" (the model making and changing themes,
cards, toasts, Undo, the skill). A third report, on the editor (Themes page, inspector,
`contrast.ts`, the views store), is another branch's. This one touches the Themes page
in one place: the "not loaded" line gets Delete (files 6), which the report asked for there.

## Decisions

- **Versions, not a `.prev`.** The store keeps every valid version of a user theme it sees
  replaced or removed in `themes/.history/<id>/<version>.json`, the newest 10 per theme
  (`MaxHistory`), whatever replaced it: `theme save`, the editor's Save, a thread's
  refinement, a hand edit, Finder. A `.prev` would only undo the latest save; a chain of
  refinements needs one version per card. `theme delete` removes the theme's versions with
  it; a file removed by hand keeps its last version (`theme restore` brings it back).
  `UserTheme.history` (field 12) lists them, newest first, so the GUI knows whether a card's
  version is still there. `theme.restore <id> --version <v>` writes the kept bytes back as
  they were (created_by included), keeping what it replaces in turn.
- **One Undo rule**, the same in the daemon (building the card and its toast) and the GUI
  (`stores/themeCards.ts themeUndoState`, the card and the toast's link): Undo puts back what
  the slot showed immediately before that card's save, not before the thread began. That is
  another theme (`previous` = its id, `theme.set-<scheme>`), or, when the slot already
  showed the theme and the save changed its colours, the version the save replaced
  (`previous` = the theme's own id, `previous_version`, `theme.restore`). A save that
  changed no colour (a pair-only re-save) has no Undo. The button is shown only while the
  slot still shows this card's colours (the slot's id and the same scheme, base and pins);
  it reads "Undone" once the slot is back on what it put back; it is disabled with a
  tooltip ("Nord was deleted", "The previous colours of Ocean are no longer kept") when that
  is gone. `ThemeItem.previous_gone` (field 5) is the daemon's view when it made the card;
  the GUI checks again. The thread store's `inheritPrevious` is gone. In a chain of
  refinements only the latest card offers Undo; undoing it brings back the one before.
  The toast's link is `theme-undo:<scheme>:<id>:<previous>[:<version>]`, run by the same
  rule; when it no longer applies the click says why instead of changing anything.
- **Saves that would lose something are refused.** A save that changes the scheme of a theme
  a slot of the old scheme shows ("ocean-dusk is your dark theme; a light theme needs another
  id"). From a thread, a save over a theme the thread did not make, unless `--replace` (the
  skill says: once the user asked to change that theme; `theme ask --pair` says to pass it
  for the original's `pair`). A replace keeps the theme's `created_by`.
- **Forgiving reads.** `theme.ParseStored` drops a pin of a name that is not a slot and
  reads a scheme its surface contradicts as the surface's, each with a note logged once per
  file (INFO "read leniently"); the file is put right on its next save. A mid-grey surface
  stays an issue. A slot on a user theme now of the other scheme falls back along its
  `from` (`theme.Set.Fallback`), as a gone one does.
- **The seen index.** `themes/.seen.json` maps every user theme id the store has read valid
  to its `from` (at most 1000 ids; past that the gone ones go first). A theme that is not
  valid now is gone with that `from` however it went: while the daemon ran, before a
  restart, or while the app was closed.
- **In-use files first.** Past 500 files the store reads the files the slots name first
  (`usertheme.Options.InUse`, the daemon reading `settings.toml` with `settings.ThemeSlots`,
  asked only then); the rest say "over the 500-file limit".
- **Writes.** A file named `<id>.json` in another case is renamed to it before the write
  (only when no entry has the exact name, so a case-sensitive volume never loses the other
  file). A symlink is written through to its target, keeping the target's mode; a dangling
  one is refused. A Finder copy ("ocean-dusk copy.json") is told its id is taken and to give
  it a new id, not to rename it over the original.
- **`theme delete`.** Removes a file that did not load: `--file <name>`, or the id of its
  name; the GUI's "not loaded" line has a trash button for it (it asks first). Only what it
  can delete asks for a confirmation (`ConfirmIf`): a curated or unknown id is refused at
  once. When the file cannot be removed the slot goes back on the theme.
- **`theme save --apply` that fails** after the write fails with the saved lines and
  `not applied: <why>` (exit 1, no usage hint); from a thread the card is still added.
- **Scheme.** `theme.set-scheme system|dark|light` (the `appearance.theme` setting). A slot
  set for a scheme the app does not show ends with what that means: "the scheme is dark, so
  nothing changes on screen until it is light (theme set-scheme light switches it)", or with
  system, what the window shows now (`ThemeDeps.Showing`: the GUI's published theme); `theme
  list` says "scheme: system (appearance.theme), currently dark". The daemon never switches
  the scheme on its own; the skill says to offer it.
- **Verbs the model can find.** `code-foundry theme --help` and `help theme` list the group
  (a bare group with a `.show` used to print `theme.show`'s help); a domain whose only verb
  is `.show` (`usage --help`) is unchanged. The skill names every theme verb on one line and
  gives the help skill's `reference/themes.md` by its installed path (`{{cf.themesRef}}`).
- **`theme ask --pair`** computes an id no theme has (`FreePairID`: `-light` or the scheme
  word swapped, then `-2`, `-3`…, cut to 64) and says so.
- **Messages.** A value that is not one of an enum's explains why (`ArgSpec.EnumMiss`: "GitHub
  Light ("github-light") is a light theme…", "Nord is curated; copy it first") and a list of
  ids stops at 20 ("and 480 more (theme list prints them all)"; any enum at 30). An empty
  `--data -` or `@file` says so in the CLI. `theme duplicate` copies no `pair`. A name with a
  format character (U+200B, U+202E) is refused by both parsers; ids are trimmed as the GUI
  does. `theme list` no longer says "your themes are files in <dir>" (a thread took it as
  leave to edit them).

## Skill and THEMES.md

"Making a theme" (the entry skill) now says: every colour change is `theme save` (never edit
the themes folder), every verb, copy with `from` = the theme copied, the reference's path,
body text 7:1 and status text 4.5:1 and that less contrast moves `surface` and `canvas`, not
the text, fix every pair the save's check lists before replying, `--replace`, and the
scheme. Its routing row catches the app's colours in any thread ("sidebar quieter", "less
contrast", the accent), and its description gains "or to change the app's colours" (398 of
400: "what it can do, which skill to read" became "which skill to read", "states a
preference or asks you to remember one" became "states a preference to remember").

**Cap raised:** the entry skill's line cap is 83, up from 80. The section grew from 6 lines
to 9 with the content the model report showed missing (the verbs, the floors, `--replace`,
the scheme); trimmed within the section it still needs three more lines. THEMES.md (the help
skill's reference) says the same, drops the `pnpm run themes:check` advice, and says the
overrides' missing guard is no licence to go under a floor.

## Findings

Files report (files.md):

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | Scheme change drops the slot | Refused while a slot of the old scheme shows it; a slot on a theme now of the other scheme falls back along `from` |
| 2 | Re-save keeps no copy, no Undo | Versions kept (`.history`), Undo restores the replaced version, `theme.restore`; `created_by` kept on replace. The editor's lack of an expected-version precondition (last writer wins) is the editor branch's |
| 3 | Tip 10/11 files stop loading | `ParseStored` drops non-slot pins and fixes the scheme from the surface, logged |
| 4 | Case-only file name | Renamed to `<id>.json` before the write; the read says so |
| 5 | Finder copy advice | "its id is taken by …: give this file a new id" |
| 6 | Files that did not load cannot be deleted | `theme delete --file` / by the id of the name; GUI Delete on the line, full reason in a tooltip |
| 7 | `--apply` failure hides the save | Saved lines plus `not applied:`, exit 1, card still added |
| 8 | Fallback depends on restarts | `.seen.json` |
| 9 | Duplicate copies a curated pair | No pair on a copy |
| 10 | 500-file cap drops the in-use theme | In-use files read first; "over the 500-file limit" |
| 11 | Failed delete moves the slot | The slot goes back |
| 12 | Save replaces a symlink | Written through to the target |
| 13 | `ask --pair` id unchecked | `FreePairID` |
| 14 | Enum dumps | `EnumMiss` and capped lists |
| 15 | Input edge cases | Empty stdin/file, BOM, "an array", dangling symlink. Left: the nested field path of an unknown field (encoding/json does not give it), exit 1 vs 2 for `--data` over 1 MiB |
| 16 | Curated delete asks first | `ConfirmIf` |
| 17 | Names and ids differ between parsers | Format characters refused in both; ids trimmed |
| 18 | Alpha on opaque slots | Left: both parsers agree today; needs the opaque list shared with `slots.ts` |
| 19 | Slow rewrites, `/cf/theme.css` before connect, a later curated id | Left: rare or by design (the daemon derives no colour) |

Model report (model.md):

| # | Finding | Outcome |
| --- | --- | --- |
| 1, 10 | "Less contrast" ends unreadable; issues nobody mentions | Skill and THEMES.md: the floors, move surface and canvas, fix the save's check before replying |
| 2 | Project thread edits the theme file in place | Routing row for colours in any thread, "never edit the themes folder", `theme list` wording. A hand edit stays safe: the watch repaints, a broken edit falls back to `from`, and now its previous version is kept |
| 3 | Pair overwrites an unrelated theme | `FreePairID`, `--replace` |
| 4 | Undo to a deleted theme | Disabled with a tooltip; the toast's Undo says why |
| 5 | Old card's Undo undoes a later choice | Hidden unless the slot still shows the card's colours |
| 6 | Undo with a new id or overlapping threads | One rule: what the slot showed immediately before the save (as asked, not before the thread) |
| 7 | Verbs not found | `theme --help` lists the group; the skill names every verb |
| 8 | Light theme while dark | The save says what the app shows (system resolved); `theme set-scheme`; the skill says offer, never switch |
| 9 | `find /` for themes.md | The skill gives the installed path |
| 11 | Editor draft overwrites a newer save | Left: the editor branch (editor report 1) |
| 12 | Hidden child's card | Left: unlikely; the card stays in the thread that saved |
| 13 | Ask prompt vs skill on `--data`/`--file` | Both say `--file <path> --apply` |
| 14 | Replies too long, command names | Unchanged rule ("a sentence or two"); "offer a next step" dropped for the room |
| 15 | THEMES.md contradicts the skill | `pnpm` advice gone; the slot error points at the help skill's reference |
| 16 | `from` records the slot in use | The skill: `from` is the theme copied |
| 17 | One-way pair | The `--pair` prompt says both ways (with `--replace`); not enforced |
| 18 | "Put back what I had" uses a stale snapshot | Partly: each card's Undo is now its own step; the skill has no extra rule |
| 19-22 | Apply-only cards, toast noise, per-project themes, shared `created_by` | Left (19 shipped as Apply in #332; a pair-only save has no Undo now) |

## Verified

- `make check` green. New tests: Go `TestParseStored` (table), the format-character and BOM
  cases of `TestParseFile`, `Set.Fallback` on a theme now of the other scheme and the capped
  id list; `TestHistory`, `TestSeenSurvivesARestart`, `TestSaveTarget` (table: another case,
  a symlink, a dangling one), `TestDeleteFile` (table), `TestInUseReadPastTheCap`;
  `TestThemeSlots`; `TestShowThemeUndoTarget` (table); `TestThemeSaveGuards` (table),
  `TestThemeSaveApplyFailure`, `TestThemeSchemeNote` (table), `TestThemeSetScheme`,
  `TestThemeRestore` (table), `TestThemeDeleteFiles` (table), `TestFreePairID` (table); the
  card test's refinement now expects the replaced version; `TestHelpGroup` gains the `.show`
  group cases; the empty-stdin and empty-file arg sources. Frontend
  `stores/themeCards.test.ts` (the Undo rule, table), the snapshot's history, the link kind.
  e2e (mock, WebKit): Undo hidden when the slot moves on and back, a refinement's Undo
  restoring the colours (and the earlier card's Undo returning), a deleted target's
  disabled Undo with its tooltip, the issues line's Delete with its confirmation;
  `theme-model-flow.spec.ts` and `user-themes.spec.ts` pass whole.
- Built daemon, CLI and app on a scratch `CODE_FOUNDRY_HOME`, no inherited `CLAUDE*` /
  `CODE_FOUNDRY_*` variables: every files finding from 1 to 15 run through the CLI (the
  scheme-change refusal, a refinement's kept version and `theme restore`, a tip-10 file
  with `--cf-primary` and a light surface on "dark" loading with one INFO line, `Caps.json`
  renamed by a save, the Finder copy's message, `delete --file` and by id with their
  confirmations, a curated delete refused at once, `--apply` against a broken
  settings.toml, the fallback after `daemon restart`, a duplicate without `pair`, a delete
  under `chmod 500` putting the slot back, a symlink written through, the enum and empty-stdin
  messages, the scheme notes). No ERROR lines.
- Haiku 5.5 medium threads (`claude-haiku-5-5[1m]`):
  - **Less contrast (model 1 / prompt 5):** `theme ask "my eyes hurt, less contrast
    please"`, then "still way too harsh, grey on grey, much dimmer text", then "I can't see
    any difference… pin it if you have to". It loaded the skill, read the reference by its
    path (no `find /`), lifted the surface and canvas, and every save printed `contrast: ok`.
    Asked to pin, it declined: "Pinning the chat or sidebar text below its contrast floor
    fails the check, and the app's rules would lift it back up anyway", darkened the
    background instead and said 7:1 is as low as the app goes. It did run one bounded
    `find` for `slots.ts` in the scratch home and `/Applications` (nothing found).
  - **A project thread (model 2 / prompt 6):** after a README edit, "make the sidebar
    quieter" made it ask which sidebar; told "the app's", it loaded the help skill and
    offered Compact density. Told "its colours", it duplicated a theme and then edited the
    copy in the themes folder with its Edit tool (the watcher repainted; no card). After
    that run the help skill's settings line says theme files are never edited by hand
    ("colours, `theme save`"), and a save's `written to:` line says to change it with `theme
    save`, not in place. A fresh project thread, "make the sidebar colours quieter": it
    loaded the entry skill, `theme list` / `show`, wrote the file in its pages folder and
    saved with `--apply` (card, Undo to GitHub Dark, `contrast: ok`), touching nothing in the
    themes folder.
  - **A light theme while dark (model 8 / prompt 10):** scheme dark, `theme ask "a warm
    light theme, like old paper"`: the save printed "the scheme is dark, so nothing changes
    on screen until it is light (theme set-scheme light switches it)", and the model replied
    "Your app is currently in dark mode, so you won't see the change yet. Should I switch the
    app to light mode…?" The scheme stayed dark; on "yes please" it ran `theme set-scheme
    light`.
  - **Pair (model 3):** with an unrelated `warm-paper-dark` saved, `theme ask --pair
    warm-paper` was told `warm-paper-dark-2`, saved it, and re-saved Warm Paper with
    `--replace`; the unrelated theme was untouched and Warm Paper kept its `created_by`.
- The app (`make gui-build`): a thread's three Harbor cards in the Wails window (shots by
  window id in the PR body, dark and light): Undo on the refinement with the earlier card's
  hidden; after the restore, "Undone" on the refinement and Undo back on the first; a third
  card whose previous theme was deleted, its Undo disabled. The Themes page's "not loaded"
  line with its Delete. The window takes no synthetic clicks here, so the clicks were the
  e2e's; the window states were set through the CLI.
- Afterwards the slots and scheme were put back and every scratch theme deleted (so the
  WebKit storage the real app shares keeps none), the app and daemon stopped, the home,
  the scratch project and the five thread transcripts deleted.

## Daemon restart

Needed: the store (versions, seen index, forgiving reads), the verbs, the proto fields,
the CLI's group help and the skills (written at daemon start). GUI and daemon ship together.

## Gotchas

- `os.Rename` over a name that differs only in case keeps the old entry's name on a
  case-insensitive volume; renaming the entry itself first is what changes it.
- The history is written from `loadLocked`, so every way a theme changes is covered; Delete
  marks its id so the version it removes is not kept a moment before its history goes.
- The skill's `{{cf.themesRef}}` renders the daemon's skills directory; tests use
  `/Users/ada/...`.
