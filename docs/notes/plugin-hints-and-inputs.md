# Plugin hints, input kinds and icons

A gap review of `pluginsdk/ui` against what the app uses. This is the cheap half; menus come
next, and tables, charts and images wait on the `html` node decision.

## Host fixes (no SDK change)

- Text the renderer cut had no way to be read on chips, section titles and meta, progress
  labels, log and terminal titles, divider labels, the header title and note, the master-detail
  back button and select labels. They now use `Tip whenTruncated`.
- A status dot's colour said nothing on hover: `GlyphView` shows the status in words. `named`
  turns that off where the words are on screen (a row's pill, an empty state).

## SDK additions

- `hint` on button, chip, glyph, pill and span. Only for what is not on screen, per the
  tooltip rule in `CLAUDE.md`. An icon-only button shows it under its label.
- `InputMultiline` and `InputNumber`. Multi-line stays out of toolbars and footers (one row).
- `Input.Live`: the change event as the user types. `liveSender` (form.ts) waits 300 ms and
  keeps one act in flight, because the plugin handles requests concurrently and an older
  filter must not answer after a newer one. A live field skips the blur send.
- Capabilities: `view.hint`, `view.input.multiline`, `view.input.number`, `view.input.live`.
  The host decodes views leniently, so an older host ignores `hint` and `live`, but `Validate`
  refuses an unknown input kind there.

## Decisions

- Icons: superseded by `plugin-all-icons.md`.
- A chip with a `hint` shows the hint, not its cut label: one tooltip per element.

## Gotchas

- `Tip` on a disabled button needs a span around it: a disabled button gets no pointer events.
- A dropped view version is not an issue for live acts: they name the version on screen, and a
  version still acts for 3 s after a newer one.
