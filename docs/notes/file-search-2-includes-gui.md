# File search 2: ignored files to include, in the GUI

Status: PR 2 of 5 for file search, on branch `cf/file-search-2-includes-gui`. PR 1
(`docs/notes/file-search-1-includes.md`) gave the daemon include patterns: the
`files.include_ignored` setting, each project's own list, `FileMatch.ignored` and
`SuggestIncludeIgnored`. This PR is the GUI for them. Next: (3) ripgrep shipped with the
release, (4) a text search RPC, (5) a Text mode in the finder (the Files / Text switch and the
"tab" hint from the sketches are that PR's, not this one's).

The design was agreed from two static sketches: the Settings list, and "1 · Project setting" and
"2 · ⌘P with included files". The user chose ⌘⏎ over the sketch's ⌥⏎ for "for all projects".

## What landed

| Path | What |
|---|---|
| `src/lib/includePatterns.ts` | pure: parse and format the setting (`none` is the empty list), missing and restored defaults, the effective list with each pattern's scope, the typed text as one pattern (a comma refused), counts, the daemon's message without "invalid argument: " |
| `src/api/filesystem.ts`, `src/api/project.ts` | `FileMatchView.ignored`, `FinderMatchView.ignored`, `suggestIncludeIgnored` and its view, `ProjectView.includeIgnored` (optional: absent is none, so the many fixtures stay as they are) |
| `src/components/includes/` | `PatternRows` (row, badge, ×, error, the plain add field), `IncludeAddField` (the project's field with the suggestions popover), `useIncludeSuggestions`, `useIncludeSetting` (the setting as a list, saved through `saveSettings`) |
| `src/components/settings/IncludeIgnoredSettings.tsx`, `sectionBodies.ts` | the General › Files section as the setting's own list; the same list as the key editor of the setting's search row |
| `src/components/settings/SectionCard.tsx`, `keyEditors.ts` | `SettingsSection` hands a section to its registered body; the key editor and its tall row |
| `src/components/projects/ProjectSearch.tsx`, `src/stores/projectIncludes.ts` | the project page's Search section (git projects, after Details); `setProjectIncludes` runs `project.files.include` |
| `src/lib/fileFinder.ts`, `components/palette/FileFinder.tsx` | `FinderRow.ignored`, the quiet `ignored` label before `open`; ⌘⏎ for @ in prompt |
| `src/lib/completion.ts`, `components/compose/CompletionCard.tsx` | `CompletionItem.note`, "ignored" at a file row's right |
| `internal/command/commands_view_file_find.go` | the description says ⌘⏎ |

## Decisions

* **Settings: a section body, not just a key editor.** The sketch has the list full width with
  "Restore N defaults" at the heading's right, which a row's 18rem editor column cannot hold.
  `sectionBodies` (by `<page>/<section>`, like `sectionLinks`) lets a section draw itself:
  General › Files is headed by the setting's title ("Ignored files to include"), not the
  section's ("Files"); the section has this one setting. The search still finds the field and
  shows its row; that row's key editor is the same list in a box, with the restore link under
  it, so the raw comma string is never an editor.
* **The setting's description in the GUI is the sketch's**, shorter than the field's (which the
  CLI and the search show and which explains the pattern syntax and `none`). It leaves out
  "text search" until that exists (PR 5 adds the words).
* **Saving.** Every change writes the whole list: `formatPatterns` joins with ", " and writes
  `none` for the empty list (an empty value would reset to the defaults). Restore appends the
  missing defaults after the user's patterns and never reorders or drops them. The settings
  list saves through `saveSettings` directly (not the row's `commit`), so the add field can be
  cleared once saved and keep its text with the message when refused. No success toast: the
  list shows the change in place (the toast rule's in-view case).
* **Project page.** The effective list (`fsx.MergeIncludes`' order): the setting's patterns
  with an "all projects" badge, then the project's own; a pattern in both shows once, as all
  projects. × on an all-projects row edits the setting (the badge is what says so). Enter adds
  to the project, ⌘⏎ to the setting; a pattern already covered at that level writes nothing.
  The project's list goes through `project.files.include` (every user action is a command);
  `runCommandForResult` with `inView` (no success toast: the list changes in place,
  `docs/notes/toast-success-rule.md`) and `expected` for InvalidArgument, so a refused pattern shows under
  the field and is not toasted; other failures are toasted and shown.
* **Suggestions** (`SuggestIncludeIgnored`, 100 ms debounce, 20 asked, aborted when the text
  changes or the field closes; asked again when the effective list changes, since `included`
  does): the project's ignored entries with the typed letters bold, folders with a trailing
  "/" and their file count, entries already included shown dimmed with "included" and not
  pickable. The typed text's own count is inside the field's right ("matches 212 files"); its
  `text_error` shows under the field.
* **What Enter adds.** With no text, the first pickable suggestion is picked. With text, the
  first pickable suggestion whose pattern the text begins (a path being typed out) is picked,
  else nothing, and Enter adds the text as typed. ↑↓ cycle through the suggestions and, with
  text, the text itself. So `docs/scr` plus Enter adds `docs/scratch/` and `gui/frontend/test`
  picks `gui/frontend/test-results/` (the sketch's highlighted row), while `*.log` or `scratch`
  plus Enter add what was typed. Rejected: "pick the first suggestion unless the text
  includes files of its own", which made `*.log` in a project with no log files yet add
  whatever the fuzzy ranking put first.
* **Room below.** The field is the page's last thing, so Radix flipped the popover above it,
  over the section's own list. While the popover is open the field keeps a spacer (h-80)
  below itself and scrolls it into view: the popover opens under the field.
* **Escape.** In the project field: closes the popover (Radix), then clears the text. In the
  settings field: clears and blurs, like a text setting, because the settings sheet leaves
  Escape to a focused field; the next Escape closes the sheet.
* **The add field stays enabled while a save is out** (Enter waits), so it keeps the keyboard
  between adds; the × buttons are disabled meanwhile, one write at a time.
* **⌘⏎ replaces ⌥⏎** for "@ in prompt" in the finder, including the Enter that waits for the
  typed query's answer. ⌥⏎ now falls through to cmdk's Enter (opens the file). No global
  binding uses cmd+Enter, which the e2e check confirms through the real keymap.
* **The `@` card** had room: a quiet note at the row's right, before the selected row's ⏎.

## Left out

* **Per-row file counts** on the project page's list (the sketch shows "3 files" per
  pattern). The RPCs that exist cannot give them cheaply: `SuggestIncludeIgnored` counts the
  typed text only, so a count per row means one call per pattern, each listing the ignored
  entries again (about 30 ms on a large checkout, and a walk for folders) every time the page
  shows or a pattern changes. Left for a daemon field if wanted.
* The sketch's "Or keep typing a pattern" group: the count inside the field says what the
  typed text would add.

## Tests

* Vitest: `lib/includePatterns.test.ts` (parse, format and `none`, restore keeping the
  user's patterns, the effective list, the typed pattern, counts, the error text);
  `settings/IncludeIgnoredSettings.test.tsx` (fresh, remove, add, restore, the last one to
  `none`, a refusal kept in place, a comma, Escape, the search row's list);
  `projects/ProjectSearch.test.tsx` (the list and its badges, × at both levels with the
  command's args and context or the setting's value, `none`, Enter and ⌘⏎, a refusal not
  toasted, suggestions: counts, included, picking, typed text, its error, Escape, a failed
  ask); `ProjectPage.test.tsx` (the section after Details, git only);
  `palette/FileFinder.test.tsx` (the ignored label, ⌘⏎ and its wait, ⌥⏎ opening, the hint);
  `lib/completion.test.ts`, `compose/CompletionCard.test.tsx` (the note);
  `api/filesystem.test.ts` (the mappings and the request).
* Playwright: `e2e/file-search-includes.spec.ts` (the field's keys inside the page's
  listbox and the popover below the field in the window; SHOTS=<dir> saves the PR's
  screenshots, before and after); `e2e/file-finder.spec.ts` presses Meta+Enter.

## Verified

* `make check` green.
* A scratch dev daemon (`make drive DAEMON=dev`, its own home under /tmp) and a scratch git
  repo under home with `.env`, `.env.local`, `src/.env`, `CLAUDE.local.md`,
  `.claude/settings.local.json`, `node_modules/dotenv/.env.example`, `build/reports/a.html`,
  `docs/scratch/plan.md` and `app.log` ignored, registered with `project add`, driven with
  `playwright cli`:
  * Project page: the three defaults badged all projects; `docs/scr` suggested
    `docs/scratch/` (1 file) and Enter added it to the project (`includeIgnored` in
    `project list --json`); `*.log` showed "matches 1 file" and ⌘⏎ wrote it to the setting;
    `../x` and `!keep` showed the daemon's reasons under the field; `project.files.include`
    with `../x` came back as the message without its prefix and no toast; × removed
    `docs/scratch/` from the project and `*.log` from the setting.
  * Settings: removing `CLAUDE.local.md` offered "Restore 1 default"; adding `scratch/` and
    removing all wrote `include_ignored = "none"` to settings.toml with "Restore 3 defaults";
    restore brought the three back; with `scratch/` added and a default removed, restore
    kept `scratch/` and appended the default.
  * A thread in the project (no prompt sent): cmd+P "env" listed `.env`, `src/.env` and
    `.env.local`, each labelled ignored, and not `node_modules/dotenv/.env.example`; ⌘⏎ put
    `.env` in the prompt as a tag; `@loc` listed `.env.local`, `CLAUDE.local.md` and
    `settings.local.json` with "ignored".
  * Cleanup: the thread closed, the drive stopped (its daemon and Claude gone, by the task
    that started them), the scratch repo and home deleted.

## Gotchas

* The settings sheet gives Escape to a focused input, so a field inside it has to let go of
  the keyboard on Escape for the sheet's next Escape to close it.
* `sectionBodies` → `IncludeIgnoredSettings` → `SectionCard` → `sectionBodies` is an import
  cycle; it is safe because the record only holds a function declaration, read at render.
* `react(only-export-components)`: a component file may not also export a plain function, so
  `setProjectIncludes` lives in `stores/projectIncludes.ts`.
