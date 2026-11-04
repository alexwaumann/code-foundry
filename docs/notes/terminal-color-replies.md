# Terminal color replies

A user found `11;rgb:2121/2525/2b2b` sitting at their prompt after `gh pr checks --watch`
in a bottom-panel terminal. The same command in standalone Ghostty was clean.

## Cause

`gh` (through termenv) asks for the background with OSC 11 and sends a cursor position
query right behind it, as a sentinel: a terminal that does not know OSC 11 still answers
CPR. It reads one reply, and if that is not the OSC reply it decides the terminal has none,
restores the tty and moves on.

The daemon answered CPR at once. It could not answer OSC 11 (libghostty stays silent with
no default colors), so xterm.js did, after a trip to the GUI and back. CPR always won, `gh`
stopped reading, and the color reply reached the shell as typed text. ZLE ate the `ESC ]`
in front, which leaves exactly the text the user saw.

Nothing about `--watch` matters: under a pty with the same reply order, plain `gh pr
checks`, `gh pr list` and `gh pr view` leak the same way. Piped, `gh` does not ask. Replying
in the right order keeps the prompt clean.

`terminal-shift-enter.md` left these queries to xterm because the daemon had no colors to
give. That was true, not necessary: `theme.Live` already has the GUI's theme.

## Decisions

* **The emulator answers.** `Manager.SetColors` gives every emulator default foreground,
  background and cursor colors, and xterm swallows queries that only ask (`?`, `?;?`), the
  way it does for OSC 4. A payload that sets a color still reaches xterm.
* **The store stays theme-agnostic.** `terminal.Colors` is three RGBs; `internal/daemon`
  maps a `theme.Frame` to them through the slots `terminal/theme.ts` paints with
  (`--terminal-fg`, `--cf-surface`, `--terminal-cursor`). Alpha is dropped.
* **`PublishTheme` forwards**, through `UI.WithThemePublished`, so a theme switch reaches
  running terminals too. Dark defaults apply until the GUI publishes, which is what a
  terminal without a GUI answers from a daemon that never saw one.
* The last `SetColors` wins: each actor reads the current colors when it applies them. A
  `Create` that raced one applies them again once it is in `m.actors`.

## Gotchas

* The default colors do not change snapshots: the VT formatter writes the same bytes with
  and without them (probed), so attaching is unaffected.
* A program's own OSC 11 set stays in front of the defaults in the emulator until OSC 111,
  and a theme switch does not move it. xterm drops the override from the screen on a theme
  switch, so until the program resets it the reply can name a color no longer painted.
* A payload that both asks and sets (`OSC 10;?;#102030`) goes to xterm, which has to apply
  the set, so it also replies, late. No program is known to send that.
* OSC 4 palette replies still use libghostty's default palette, not the theme's. Nothing
  has asked for that yet.

## Verification

Against the real app (`scripts/drive.sh dev`: real daemon, xterm.js in WebKit), real `gh pr
checks --watch` at a zsh prompt, Atom One Dark. On `main` the prompt came back holding
`11;rgb:2121/2525/2b2b`, and the raw reply was echoed above the output. With the fix the
prompt is empty.

A loop in a running terminal asking OSC 11 and CPR got the color first and followed live
theme switches: `2121/2525/2b2b` (Atom One Dark), `2e2e/3434/4040` (Nord), `ffff/ffff/ffff`
(GitHub Light).

`terminal_colors_e2e_test.go` holds the daemon wiring: without it xterm's silence would
leave every color query unanswered.
