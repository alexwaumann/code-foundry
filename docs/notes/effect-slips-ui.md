# Effect slips in the UI

An audit of the frontend's effects found four that did work belonging in render or in an
event handler. Each got a local fix, one commit apiece, and CLAUDE.md gained a rule.

## Command palette: the auto-run effect (removed)

`PaletteBody` ran a pre-selected command with nothing to ask from an effect (`autoRun`).
Under StrictMode's effect replay that would run the command twice. It was unreachable:

- `openPalette(query, commandName)` is the only way into it. Its callers with a command are
  `startCommand` (keys/bindings.ts), which opens the palette only when `promptedArgs(c)` is
  non-empty and invokes directly otherwise, and the Plugins page's "Add a dev plugin"
  (`plugin.dev`, whose `path` is `Required` with no context binding). `intents.ts`,
  `togglePalette`, `ui.palette.open` and ProjectPicker open it without a command.
- Prompted args are required args without a context binding, or enums
  (`commandToProto`: `Required: a.Required && a.Context == NoContext`). Neither depends on
  the context the list was fetched in, so the palette's lookup sees the args the caller saw.

Gotcha found on the way, not fixed here: `plugin.dev` is `NoPalette`, and the pending
command is looked up in the palette's list (`inPalette` drops NoPalette commands), so "Add a
dev plugin" opens the plain command list rather than the path prompt. It has done so since
NoPalette landed.

## Colour picker: OKLCH held with its hex

The local OKLCH exists because a hex cannot hold the hue of a grey. It was copied from the
`value` prop in an effect, with a ref of the last emitted hex to tell its echo from an
outside change. Now `{hex, lch}` is one state; render adjusts it when `value` differs from
the held hex, taking the value's OKLCH and keeping the held hue for a grey.

The adjustment uses an updater that checks the latest held hex again. The parents write a
zustand store, whose re-render may run at a different priority from the picker's own
update during a pointer move; a plain `setHeld(adopted)` queued from a stale render would
then be replayed after the picker's update and replace the exact OKLCH with the hex read
back. A jsdom test could not reproduce that ordering, so the updater form is defensive.

Behaviour that differs: a parent that drops a change now pulls the picker back to its own
value (it is fully controlled). Both callers store every change, so nothing visible moves.

## Prompt picker: close on another draft during render

The cleanup-only effect keyed on `resetKey` closed the picker after the new draft had
committed with the card open (and its list effect could ask the daemon for it). It now uses
the seen-key pattern the hook already had for its filter. The hook is still not keyed by
`resetKey`: a window shell composer keeps one key while its draft gains an id.

## Sidebar row: the hover slot reads data-shown

`RowActions` reported `shown` (focus inside, or the snooze menu open) to `HoverSlot` from an
effect, only to switch two classes. The slot now reads the `data-shown` the actions already
set: `has-[>[data-shown]]:min-w-[97px]` on the slot and
`group-has-[>[data-shown]]/slot:invisible` on its counts. The direct-child `>` keeps a
`data-shown` deeper in the slot from matching.

Checked in the running app (mock drive, WebKit) before and after, at rest, hovered, with
keyboard focus and the pointer away, blurred, with the menu open and after Escape (focus
back on the trigger, so still shown): the slot's min-width, the counts' visibility and the
actions' opacity and pointer-events were identical. Dark and light look the same.
