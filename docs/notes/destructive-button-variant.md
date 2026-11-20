# Destructive confirm buttons use the destructive variant

The messaging overhaul's eighth PR: the visual half of making destructive confirms look alike.

## Decisions

- **One look for a destructive confirm.** The plugin Uninstall dialog
  (`components/plugin/settings/UninstallDialog.tsx`) and the skill Uninstall/Delete dialog
  (`components/skill/settings/ConfirmSkillDialog.tsx`) drew their confirm as an `outline`
  button with hand-written red-outline classes. Every other destructive confirm
  (`ConfirmDialog`, `ActionDialog`, `RemoveWorktreeDialog`, `RemoveSpaceDialog`) uses the
  filled `variant="destructive"` Button. The two now do too, and the override classes are
  gone, so the colour comes from the theme's `--destructive` token in both schemes.
- **Nothing else moves.** Copy, which button has focus (Uninstall in both Uninstall dialogs,
  Cancel for Delete of a local skill) and layout stay as #871 left them.
- **No other hits.** No other confirm under `src/components` used the red-outline pattern.
  `pr/ReviewDialog.tsx`'s "request-changes" tint is a review-kind choice, not a destructive
  confirm, and stays.

## Tests

The vitest suites for both pages assert the confirm's `data-variant` is `destructive`
(`PluginsPage.test.tsx`, `SkillsPage.test.tsx`), beside the existing focus and copy checks.
Nothing here needs a browser, so there is no e2e test; the PR's screenshots came from a
temporary SHOTS spec that was not committed.
