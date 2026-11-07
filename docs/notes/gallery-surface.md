# Gallery surface

A `gallery` surface in the side panel: a set of images a thread shows, as a grid that opens one
image over a filmstrip. `view.panel.gallery` is the only way in. It has no palette entry
(`NoPalette`), no hotkey, and no row in the surface list (`available: "hidden"`).

## The verb

```
code-foundry view.panel.gallery --title Screenshots --images - <<'JSON'
[{"path":"/tmp/before.png","caption":"Before"},{"path":"shots/after.png"}]
JSON
```

### Why a caption travels as JSON

The command layer's repeatable flags are String only and are joined by newlines before they
reach the daemon (`thread.subscribe --arg`, `thread.reseed --add-dir`). So:

- A paired `--image` and `--caption` are two separate strings. The first image without a caption
  shifts every caption after it onto the wrong image, and nothing can tell.
- A newline in a caption would start another image.
- `--image path=caption` keeps the pair but cannot tell a `=` in a path from the separator, and
  it still has the newline problem.

`--images` is one String arg with `FileOrStdin`, which already exists, so the CLI needs no change.
It takes `-`, `@file` or the JSON itself. In a quoted heredoc nothing needs shell quoting, which
is where a caption with an apostrophe would otherwise break. An unknown field is refused, so a
`"file"` or `"label"` fails instead of losing the image or its caption without a word.

A repeatable flag cannot be a `Path` arg, and a JSON value is not one either, so the CLI does not
resolve a relative path against its own directory. It reads against the thread's checkout, as a
File tab's relative path does, and the help says so.

### Limits

- At most 200 images. Tiles are virtualized, so this is not the grid's limit. The list lives in
  the tab's params, which the panel keeps in the window's local storage, and panel entries are
  never pruned. Over the cap is refused rather than cut, so a thread knows.
- Captions at most 200 characters, titles at most 80. Both are cleaned as model text (`plainNote`
  in Go, `plainLine` in the tab).
- 32 MiB per image, the File tab's read cap, and 1 MiB for an SVG, which `ReadFile` counts as text.
  A larger one is a failed tile and a warning, not a broken picture.
- Paths at most 1,024 bytes. A failed image keeps its path in the tab's params, so without this the
  count alone would not bound what a tab stores in local storage.

### What a refusal is

An image that cannot show is a warning and stays in the list, as a failed tile in its place. A
thread can fix one path without losing the rest. Only a call where no image can show is refused,
as the other item verbs refuse what has nothing to show. Warnings name the first five and count
the others.

## Read grants

Nothing is widened. The verb checks each image through `FilesystemService.ReadFile` and the tab
reads each one the same way, so the gallery reaches what the File tab reaches: home and the temp
folders (`fsx.ReadRoots`). An image outside them is a failed tile saying "Cannot read". It does not
use preview grants, since it needs bytes and not a page.

## Same title, same tab

The tab's id comes from the title alone, and `openTab` hands an existing tab its new params. A
tab's params that do not change would change nothing, and a thread that retakes screenshots at the
same paths would see the old ones. So each image carries `stamp`, the modification time the daemon
saw, and the thumbnail key is stamp plus path: only what was rewritten reads again. The single view
stays on its file if the new list has it, else goes back to the grid. A re-open never takes the
keyboard: only the user's own moves focus the view.

## Memory

- `ThumbStore` (one per tab body) reads each image once for both the grid and the filmstrip. Only
  images a mounted tile holds load, at most 2 at a time, and one that scrolls away first stops. Two
  because each slot can hold a whole file and its decode, and a unary read shares the browser's six
  connections with the streams.
- A thumbnail is at most 640 px on its longest side: a wide tile at 2x. The source URL is revoked
  and only the small blob stays, so the grid holds no full-size decode. JPEG stays JPEG; anything
  else is PNG, since it may have transparency.
- An image already small enough, and any SVG, keeps its own bytes. An SVG has no pixels to hold, and
  a canvas might refuse it.
- The single view is the only full image, through the File tab's `ImagePreview`. It gained an
  optional `onFail`, since a read can succeed and the bytes still not decode.
- A full decode still happens once per image while its thumbnail is made, so a very large image
  costs its full size for that moment, as it does in a File tab. Only the file size is capped.

## Keyboard

Arrows move in the single view, holding at the ends, and Esc goes back to the grid. They are the
component's own `onKeyDown` rather than `SurfaceSpec.onKey`, which gets a tab and has no way to the
component's state, and they only apply while focus is in the view, so a key pressed elsewhere in
the panel means what it did. The view's box takes the keyboard after every move: a filmstrip
button the arrows scroll away would otherwise take the keys with it.

Esc reaches the app's capture listener first, so with a subagent's view open in the content pane
`thread.agent.up` wins over this.

## Later: opening from an image in a thread

Not built. It would be another caller of `galleryTab`: a tab is only a title and a list.

## Gotchas

- The rows must mount only once the box has a width. Before that the grid has no height, so the
  virtualizer's `initialOffset` is clamped to 0 and the grid comes back at the top.
- `playwright cli` (`make drive`) cannot show this tab: its origin allowlist blocks `blob:` URLs
  ("Web Inspector blocked blob:…"), so every image reads "Cannot decode". The e2e suite has no such
  list. The live check used a throwaway WebKit script against the same dev daemon.
- `bunx tsc` without `node_modules` fetches a tsc and says nothing. Run `bun install` first.

## Skills and eval

The entry skill's "To see…" row names the verb. The help skill points at
`daemon.capabilities --group panel`, which lists it by itself. `p9-show-images` was added to the
eval, with `before.svg` and `after.svg` in the fixture.

## Known limit

A read that fails for a moment stays failed on its tile until the tab's body remounts: an identical
re-open changes no params, so nothing asks again. Leaving the tab and coming back clears it.
