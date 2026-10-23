# Theme editor fuzz fixes (2026-10-22)

Fixes for the fuzz report on the Themes page and the theme editor (editor findings 1-16,
run on 743cbc46 after #328-#331), rebased on #332 (theme follow-ups). Frontend only: the
Themes page, the editor, the inspector, `src/themes/contrast.ts`, the picker and views
stores, plus three files outside that set, each named below. No new command, no daemon
change, so no daemon restart.

## By finding

1. **Stale editor copy (high).** The editor subscribes to the user's themes while it is
   open (`syncFromDisk` in `stores/themeEditor.ts`). When the open theme's file changes: a
   file equal to the draft becomes the saved file (this window's save landing, or the same
   edit made elsewhere); a clean draft reloads (saved, draft and the pins' basis); over
   unsaved edits the file waits in `disk` and the inspector shows "Changed on disk ·
   Reload / Keep mine". Reload takes the file; Keep mine keeps the draft and makes the file
   what Revert goes back to, so the next Save overwrites it knowingly. Revert with a file
   waiting goes to that file. `theme edit` (and the card's or toast's Edit) on the theme
   already open runs the same sync instead of keeping the old copy. A deleted file still
   leaves the editor on its draft.
2. **900 px windows (high).** While editing, the page body's columns follow its width
   (`editorLayout` in `editor/model.ts`, measured with `useWidth`): the list is 240 px only
   when the gallery's 640 px also fit beside a 340 px inspector (a body of 1220 px or more);
   below that it folds to a 56 px strip of the themes' Aa chips (the name in a tooltip, a
   click still leaves for that theme, asking first), and below 552 px it goes. The inspector
   is 340 px from a 1000 px body, else 296 px. The edit bar wraps: the title keeps at least
   8rem and the buttons drop under it. In WebKit at 900 (body 594: strip and 296) the right column is about 242 px and Save,
   Revert and × end inside the window (e2e checks their boxes at 900, 1100, 1200 and 1440);
   at 1440 (body 1134) the list is a strip too and the whole gallery fits. The side panel is hidden on
   the page, so opening one first changes nothing (e2e). "· unsaved" now comes before
   "· from …", so a cut line still says it.
3. **Escape (medium).** `useEscapeCloses` (outside the set: `components/window/`) calls
   `preventDefault` before it closes. The confirm that close() opens mounts its Escape
   listener before the same keystroke reaches the document, and Radix's DismissableLayer
   leaves a prevented Escape alone, so the confirm stays. Settings and Usage close the same
   way. On the Themes page Escape goes back from a colour's view, then out of the editor
   (asking when dirty), then closes the page.
4. **Fix that cannot fix (medium).** `fixContrast` returns `{ kind: "none", reason,
   against, required }` instead of pinning: `unreachable` when no lightness of the colour
   holds every pair it is drawn in, `worse` when the value that holds leaves the theme with
   as many failing pairs or more (a pin feeds the rules after it: text-muted derives from
   text). The modal row drops its Fix and says "No colour on control-hover reaches 4.5:1;
   change the surface or the base colour." (or that fixing it here makes more pairs fail).
   The report's own case (a #6b6b6b surface) is now a scheme refusal (5): it is too light
   for dark. The unreachable case in the tests is a mid-grey hovered row pinned under a
   dark theme.
5. **Scheme against surface (medium).** `analyse` runs `parseThemeFile` in user mode on
   the draft (`draftRefusal`). A surface its scheme cannot carry shows under the Surface
   row in the editor's words ("A dark theme needs a dark surface (OKLab lightness at most
   0.45); #f0f0f0 is 0.96. Darken the surface to save."), the row carries a "scheme" mark,
   and the modal lists only that (the 41 contrast rows are its consequence), with no "You
   can save anyway" and Save disabled. Any other rule the file breaks shows as "Cannot
   save: …".
6. **Ask the model with edits (medium).** `AskTheModel` asks before `theme.ask` runs
   ("… The model does not see them: asking starts a thread and leaves the editor. Drop
   them?"); Cancel starts nothing and keeps the text. `leaveEditor` takes the second
   sentence as an argument. The draft is still not sent to the model (left out, below).
7. **Customise (medium-low).** One copy per gesture (`customising` in
   `stores/themePicker.ts`). The copy Customise makes is marked fresh for this window's
   editor; leaving the editor without a save deletes it (`theme.delete`, confirmed, without
   asking), unless a slot uses it by then; Delete on it, a save, or any newer file of it
   clears the mark. `leaveEditor` waits for that delete, so a second Customise of the same
   theme takes the same id again. A preview of a theme that went away shows the slot's theme
   (and has nothing to apply). The second click of a double-click on a row or a row action
   is ignored (`detail > 1`): the first click can move another row under the pointer.
8. **Keyboard (medium-low).** Focus follows the views: a new editor focuses its first row,
   a colour's view its hex field, Back (or Escape) the row that opened it, the modal's close
   the Save… button, leaving the editor the theme list. In the lists ↑/↓ walk the rows
   (base colours, the tones, group headers, slots) and ↓ from the filter goes to the first
   slot, since WebKit's Tab skips buttons. The slot list is not a listbox (left out).
9. **List arrows in the editor (low-medium).** ↑/↓ in the theme list do nothing while
   editing (a click still leaves for another theme); the footer reads "esc close the
   editor".
10. **Colour fields (low).** The hex field takes `#abc` / `abc` (expanded); anything else
    is marked on Enter (red ring, "Use #rrggbb (or #rgb).") and reverts on blur; an empty
    one reverts. An emptied L/C/H/A field reverts instead of committing 0. The hue wraps
    (−50 is 310).
11. **Out-of-gamut chroma (low).** Every change holds chroma to the sRGB edge at its
    lightness and hue (`maxChroma`), so the fields say what the hex is; at L 0 a blue
    stays a blue black. A hue drag can lower chroma and dragging back does not raise it
    again.
12. **Pinned only + filter (low).** "No pinned slot matches “zzz”." when there are pins.
13. **Names (low).** No silent `maxLength`: a count shows past 60 characters, past 80 it
    is red and Save is held (the file rule). A control character is refused in the modal
    ("Cannot save: name: no control characters"). A name another of your themes has gets
    "Another of your themes is called this." (allowed, as the daemon allows it).
14. **Sidebar Cancel (low).** `startViewSync` (views store) puts the selection and its
    history back when the confirm is cancelled; `afterLeavingEditor` and `setPages` gained a
    `stay` callback for it.
15. **Accent equal to the surface (low). Left out:** a non-text accent pair would join
    `CONTRAST_PAIRS`, which `contrast.test.ts` holds every curated theme to, and the
    catalog and the daemon's copy would need checking. Its own change.
16. **Small ones.** A group header does nothing while a filter or Pinned only holds every
    group open (its stored state no longer flips unseen). The theme search keeps the
    "did not load" lines it matches, and says nothing matches only when neither does. Left
    out: the Ask thread's context sentence (#332 moved it to the system prompt), the CLI's
    `theme edit nord` wording (daemon), and performance at 50 pins.

## Outside the set

- `components/window/useEscapeCloses.ts` (3): one `preventDefault`.
- `mock/userThemes.ts`, `mock/server.ts`: `POST /__mock/themes/edit?theme=<id>&<base
  key>=<#hex>`, a save from outside the window, for finding 1's e2e.
- `AskTheModel.tsx` sits on the Themes page; `theme.ask` itself is unchanged.

## Gotchas

- The scheme rule refuses any dark surface above OKLab L 0.45, and on such a surface white
  text reaches 7:1, so "text on surface" is never unreachable in a file the daemon takes.
- The default e2e viewport (1280) now shows the strip while editing; specs that read the
  edited row's second line run at 1600.
- A copy dropped by Customise numbering: before the delete was awaited, a second Customise
  raced it and got `-copy-2` or `-copy` at random.

## Verified

- `make check` green. Unit: `fixContrast` unreachable and never-worse, the disk sync (clean
  reload, Reload, Keep mine, Revert to the newer file, own save landing first), the fresh
  copy delete and keep, `draftRefusal` (scheme, control character, length),
  `parseHexInput`, `maxChroma`, `editorLayout` at the four window widths.
- e2e (WebKit): `theme-editor-fuzz.spec.ts` (16 tests, one per finding group, the four
  widths and the side panel), and the updated `theme-editor`, `user-themes`, `themes`,
  `theme-model-flow` and `settings` specs. The theme specs ran 24 times over with
  `--repeat-each` after the double-click guard, with no failure.
- The built app on an isolated `CODE_FOUNDRY_HOME`: see the PR body.
