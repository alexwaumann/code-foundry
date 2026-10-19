# Custom backdrop needs an image

Follow-up to `custom-backdrop.md`. Choosing Custom with no image added left
`appearance.backdrop = custom` with an empty `backdrop_file`: nothing rendered and the select
showed a dead option. Custom now exists only while it has something to show.

## Behaviour

- The select lists Custom only when the backdrops folder has at least one image. With none
  it offers Forest and None. A thumbnail click still saves `custom` + that file, and an
  import still selects the new image (the daemon's `Import`, unchanged).
- Removing the image `backdrop_file` names clears it and turns `custom` into `forest`; this
  was already in the daemon's `backdrop.Store.Remove` (so the CLI and the GUI agree) and is
  unchanged. Removing any other image changes nothing else.
- `custom` whose image is not there (no file named, or a file removed by hand) renders the
  forest art, and the select shows Forest. While a named image is still loading, nothing
  renders (no forest flash before the user's picture).

## Daemon validation

- `settings.Update` refuses `appearance.backdrop = custom` unless `appearance.backdrop_file`
  names a regular file in the backdrops directory. Messages:
  - `custom needs an image: add one under Settings › Appearance › Backdrop first` (empty file)
  - `custom needs an image, and "x.png" is not in the backdrops folder` (missing file)
  So `code-foundry settings set appearance.backdrop custom` with no image fails with
  `appearance.backdrop: custom needs an image: …`.
- It is a cross check (`crossChecks` in `schema.go`: keys + a function over the resolved
  values), the first rule spanning two keys. Update runs it only when the partial sets one of
  the keys, and reports it on the first of them that the partial sets (`backdrop` for
  `set appearance.backdrop custom`, `backdrop_file` for clearing the file under custom).
  Edits to other keys are never blocked by a broken backdrop choice.
- The check needs the directory: `settings.Options.BackdropsDir` (the daemon passes
  `paths.Backdrops()`). The settings store stats `dir/<name>` (Lstat, regular file only, so a
  symlink does not count, as `backdrop.Read` would refuse it anyway). Without the option only
  an empty name is refused. The backdrop store cannot be asked instead: it is built after the
  settings store and depends on it.
- `settingstest.New` sets `BackdropsDir` to `dir/backdrops`, the real home layout, so the
  backdrop and API tests run the check against the folder their store writes.
- Load and reload do not normalise: a hand-edited file saying `custom` with no image is left
  as written (no rewrite of the user's file behind their back), the renderer falls back to
  Forest and the select shows Forest. The row's reset arrow is visible then (the value is
  not the default), and resetting clears it.
- The order inside the backdrop store keeps the check happy: `Import` stores the file before
  it selects it, and `Remove` deletes the file, then clears `backdrop_file` and turns
  `custom` into `forest` in the same Update.
- The mock daemon mirrors the check (`MockSettings.backdropExists`, wired by
  `MockBackdrops`). `settings/external` (a hand edit) bypasses it, like a real hand edit.

## GUI

- `EnumEditor` gains `hide?: readonly string[]`: values left out of the list. The caller keeps
  `value` out of it (Radix would show an empty trigger otherwise). Generic; the backdrop row
  is its only user.
- `BackdropEditor` computes the shown value and the hidden list from the image list:
  - before the list arrives, `custom` is taken at its word (Custom listed, value shown);
  - after, `custom` whose file is not listed shows as the field default (Forest);
  - Custom is hidden when the list is empty (or, before it arrives, when the value is not
    custom).
  The list refreshes after a removal before the daemon's settings snapshot arrives, so the
  select shows Forest as soon as the thumbnail goes.
- `Backdrop.tsx`: `CustomBackdrop` returns nothing while loading and the default's art when
  the name is empty or the image resolves to null (gone, or a failed fetch).

## Tests

- Go: `TestUpdateBackdropChoice` (settings, table: no image, missing image, present image,
  remembered image, clearing under custom, missing image under forest, forest from a broken
  custom, another key under a broken custom, no directory), `TestCustomNeedsAnImage`
  (backdrop: remove the selected → forest; custom refused with and without the old name;
  re-import selects). The existing `TestRemove` table covers the fallback rules.
- vitest: `BackdropEditor.test.tsx` (table: options and shown value for no images, an image,
  custom with no file, custom with its image gone, custom listed; removing the shown last
  image shows Forest and drops Custom before the snapshot; removing another keeps the
  selection), `Backdrop.test.tsx` (custom with its image gone / no file named renders
  forest, nothing while loading).
- e2e: `settings.spec.ts` removes the last image and checks the list is Forest and None;
  `start.spec.ts` expects the forest for a gone file.
