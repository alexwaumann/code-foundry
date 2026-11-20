# A sheet over the thread keeps the keyboard

Found while checking a release build by hand: Choose Theme run from the command palette
opened the Themes sheet, but the keyboard was in the thread's prompt behind it. Typing went
into the prompt, Enter sent it as a message to the thread, and Escape did not close the sheet.
It happened twice in about a dozen runs.

## Cause

Closing the palette asks the content for the keyboard (`closePalette` bumps ui
`contentFocusSeq`; the focused pane's thread composer serves it). `theme.pick` is run in the
window, so the sheet opens in the same tick as that request. Which one lands first is not
fixed:

- the composer takes the keyboard, then the sheet's list takes it: correct, and the usual order;
- the sheet's list takes it, then the request is served: the composer's guard compared the
  focused element with the one focused when the request came in ("something took the keyboard
  meanwhile"), and here they are the same element, the sheet's list, so it focused the prompt.

Sending the request by hand once the list is focused reproduces it every time, which is what
the tests do.

## Fix

`lib/modalFocus.ts` `heldByModal(el, root)`: the keyboard is inside an open dialog or alert
dialog that is not the palette and does not hold `root`. The thread composer and the subagent
view do not serve a window-wide focus request while it is true.

- Open only: Radix marks a closing dialog `data-state="closed"`, so the request a closing
  sheet sends (the prompt gets the keyboard back) is still served.
- Not the palette: its input is where the keyboard is when its own close asks.
- A dialog that holds the composer (the Needs you popup) is the composer's own.

The new-thread composer is unchanged: it already declines on mount under an open dialog, and
a request to it (`thread.new`) is the user asking for that composer.

## Tests

- `lib/modalFocus.test.ts`: the rule, as a table.
- `SubagentPane.test.tsx`: a request under an open dialog leaves the keyboard in it.
- `e2e/themes.spec.ts`: the page opened from the palette, the request sent after its list has
  the keyboard, the list still focused and Escape closing the page. Real focus between a
  portal and the pane under it is the browser's, so this one is e2e.
