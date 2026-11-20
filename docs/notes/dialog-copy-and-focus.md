# Dialog copy, labels, close buttons and destructive focus

One pass over the GUI's dialogs and pickers (the messaging overhaul's sixth PR).

## Decisions

- **A confirm's button names its action.** The draft-set confirms in `stores/compose.ts`
  (`writeSet`) took a hard-coded "Remove" for every title: "Switch to …?" now confirms with
  Switch and "Clear the projects?" with Clear; "Remove … from the thread?" keeps Remove. The
  composer's attachment confirm said Confirm; it says Remove.
- **Focus goes to Cancel when the action loses work.** The remove-worktree dialog focuses
  Cancel while the worktree has uncommitted files (they are lost), and Remove worktree
  otherwise. The skill confirm focuses Cancel for a local skill (its folder is deleted and
  no marketplace can bring it back) and the confirm button for Uninstall (it can be
  installed again). The plugin Uninstall dialog keeps its focus. Button styling is
  unchanged here; that is its own PR.
- **"Delete" for the one action that deletes a user's own files.** A local skill's menu
  item, confirm title and button, and its working words ("Deleting…") say Delete. The
  command (`skill.remove`) and its palette title are unchanged.
- **"goes" became what happens.** "<path> is deleted. The branch <branch> stays." and "its
  package / link is removed from <dir>". `lossLine` in `lib/leftovers.ts` is unchanged.
- **The New tab's warning is not green.** "Created <name>." stays in the success colour and
  "Closing this dialog without publishing deletes it." is in the warning colour. While the
  Publish box is ticked the dialog has a Keep it local button, so the line adds "Keep it
  local keeps it."; unticked, the button is Done and the sentence is left out.
- **A visible × on every dialog without a footer.** Plugin Logs, plugin Registries and skill
  Registries get AddProjectDialog's × (a ghost `icon-sm` Button in `DialogClose`,
  `aria-label="Close"`, no tooltip), placed last so it is last in tab order. Logs and skill
  Registries have no other control, so Radix would focus the × on open and draw its focus
  ring; their `onOpenAutoFocus` focuses the dialog itself, as before.
- **Footer key hints follow the file finder.** One `Kbd` per key (`↑` `↓`, `⌘` `⏎`), the
  finder's glyphs (`⏎`, `⌫`, `esc`, `tab`) and lower-case verbs, in the project picker, the
  prompts picker, the composer's prompt history card and the search dialog's Find and
  Agent modes. The project picker's esc hint sits at the end, as in the finders.
- **Button casing is sentence case** in the update dialog and the old-daemon notice:
  Restart now, Install and restart now, Try again, Check again. The dismiss labels (Later,
  Not now, Hide) are unchanged.
- Smaller copy: "Add project" title; "Starting the clone…"; the clone hint and the Publish
  dialog no longer name gh; "That name is too long." for a workspace name over 100 bytes;
  `Setup action “<name>” failed`; "Delete it on GitHub after merging" (the From row above
  it already names the branch, so "it" stays); "Every contrast pair passes and no pin is
  stale."; "Leave the editor and discard them?"; neutral Agent search examples; Single's
  "nothing is lost" line now says diffs, files and terminals come back, as Panes' did (one
  constant); a page's bridge confirm no longer ends ", in no thread"; the project picker
  says "No matching workspaces or projects." when it searched workspaces.

## Left as they were

- GitHubTab's not-found line ("No repository <slug> on GitHub, or you cannot see it.") is
  already short and says both cases.
- `lib/projectName.ts` still says "At most 100 bytes." (out of this pass's scope).
- UK spellings, tooltips and the Settings layout belong to other PRs.

## Tests

Vitest: `compose.test.ts` (each set confirm's label), `ProjectPage.test.tsx` (worktree
focus with and without uncommitted files, the new body), `SkillsPage.test.tsx` and
`model.test.ts` (Delete, focus), `PluginsPage.test.tsx` (× closes Logs and Registries,
Logs focuses itself), `ProjectPicker.test.tsx` (footer, both empty texts), and the updated
strings in the update, workspace card, threads-open-as, bridge host, merge dialog and
add-project tests.
