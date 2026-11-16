# Dictation goes where the keyboard is

Holding the dictation key with the keyboard in a text field that is not a composer (the
note of a Cite, a setting's input, a rename field) put the words in a thread's composer:
`pickTarget` fell back to "the content pane's composer" whenever no composer was focused,
and with several threads open that was whichever composer had mounted first.

## The rules (agreed with the user, 2026-11-16)

A hold in Code Foundry goes, in this order:

1. to the composer that has the keyboard: live phrases and the pill, as before;
2. to another text field that has the keyboard: the host pastes the words into it on
   release, with the overlay, as it does in any other app;
3. to the composer of the thread the keyboard is in, only while that composer is on screen
   (its thread is the selected tab of a pane in this space): the pane's own composer for a
   thread's tab and its quick terminal; the linked thread's for a linked terminal, diff or
   pull request tab; the selected thread's when the keyboard is outside the panes;
4. nowhere. A terminal linked to no thread, a linked one whose thread is not on screen, a
   page with nothing of a thread's: the hold does nothing at all, no sound, no overlay, no
   microphone, rather than put words where the user is not looking.

Terminals never take dictation themselves.

## How

- The page already told the host whether a composer can take a press (`composer_target`,
  docs/notes/dictate-anywhere.md, "Routing"). The report gained `field`, and the snapshot
  `field_target`: composer, field, or neither. `stores/dictation.ts` `pickDestination` makes
  the choice; `dictation.toggle` and `dictation.hold` use its composer.
- `gui/hold.go` `routeHold`: in the app's own window a composer runs the window's session, a
  field a "system" session and a paste, neither nothing. Before, "no composer" in the own
  window meant a paste into whatever had the keyboard, which with the keyboard in a terminal
  was the terminal.
- `dictation.anywhere` now only decides other apps. In Code Foundry the key works with it
  off for a field too, as it always did for a composer.
- A composer registers its thread (`DictationTarget.threadId`); a pane's own composer is
  found by the pane's element (`data-pane-id`) holding it, a linked tab's thread through the
  layout store.
- What counts as a text field (`lib/dictation.ts` `isTextField`): a textarea or text-like
  input that is not read-only or disabled, or an editable element; not a terminal's hidden
  textarea.
- The answer is recomputed when focus, the selection, or the panes' tabs change, 50 ms
  settled.

## Not verified here

The page's choice and the host's routing are tested (`dictation.hold.test.ts`,
`hold_test.go`, the store's test). The paste itself into a field of the app's own web view
needs a real microphone and the Accessibility grant, which this machine's sessions do not
have: check on a real build that a hold in the Cite note lands there.
