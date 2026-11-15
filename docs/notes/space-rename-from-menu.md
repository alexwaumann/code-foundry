# Space rename from the tab's menu

Rename… in a space tab's context menu opened the name field and closed it again at once; a
double click worked. The item started the rename after a zero timeout, which ran before Radix
closed the menu: the menu's focus trap, then its focus return to the space tab, took the focus
from the new field, and the field's blur ends a rename (saving the unchanged name).

The item now only marks the rename, and the menu's `onCloseAutoFocus` starts it and cancels the
focus return, the way a terminal tab's Rename… already worked (`takeRenameAfterMenu`). The field
mounts after the menu has let go of the focus, so its own focus on mount holds.

Test: `e2e/shell-spaces.spec.ts` picks Rename… with the pointer, waits for the menu and its
animations to finish, and types a new name into the still-focused field. It failed on the old code
(field gone) and passed three runs in a row with the fix. The vitest menu test in
`TopBar.test.tsx` cannot see this: jsdom has no Radix focus timing.
