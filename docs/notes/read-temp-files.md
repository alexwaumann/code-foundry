# Reading files in the temp folders

Agents write to temp folders, and opening what they wrote failed with "<path> is outside your
home directory". The file viewer now reads there. Only reads: everything else stays home-only.

## What reaches temp

- `FilesystemService.ReadFile` (File tabs, `view.panel.file`) and `PreviewFile` plus the preview
  route. A later gallery can use the same read path.
- Nothing else. Projects, workspaces, thread cwds, worktrees, `ListDirectories`, plugins, the
  gitops editor and Finder commands, `WriteFile` and `CheckEdit` still refuse. `Writer.Editable`
  reads with `ReadRoots{Home: w.Root}`, so an edit check cannot reach temp by way of the read.

## Decisions

- `fsx.TempRoots(home)` is `/tmp` and `os.TempDir()`, each spelled and resolved, deduped. The
  spelled forms stay because a missing file has no resolved path: `/tmp/nope` must be NotFound,
  not a refusal. On macOS both are symlinks (`/tmp` to `/private/tmp`, `$TMPDIR` through `/var`).
- `os.TempDir()` counts only if it is a folder of the user's own or a sticky one, so a `TMPDIR` of
  `/private`, `/var` or `/etc` opens nothing. A real `$TMPDIR` is the user's and `/private/tmp` is
  sticky. A relative or missing `TMPDIR` is dropped too.
- A root that holds home is dropped, spelled or resolved: a `TMPDIR` of `/`, home or a parent of
  home would otherwise open everything to the file viewer. So is a root under home, which home's
  rules already cover: `TMPDIR=~/proj/.tmp` would otherwise make `~/proj` hold a temp folder, and
  its previews drop to one file.
- `fsx.ReadFile` takes `ReadRoots{Home, Temp}` rather than two strings: `Home` also expands `~`
  and names places in the privacy messages, so it must stay distinct. `Filesystem.WithTemp` and
  `Floor.WithTemp` are additive, so a test or caller that sets neither stays home-only.
- A temp root is never a grant's tree, in any spelling or through a link to it. A file directly
  in one gets a single-file grant, so its relative links 404 by design. `/tmp/foo/x.html` gets
  `/tmp/foo`.
- `guardedByName` walks for config-home markers up to the temp root as well as home: a dev
  daemon's home lives in `/tmp/cf-drive.XXXX` and holds `daemon.token`.
- `ReadFileResponse.outside_home` is the one fact both refusals need, so `ViewDeps` learns
  nothing about home. It is true when the real file is outside home, or the path came through a
  temp folder and is not under home. The second half matters for a link `/tmp/x.html` into home:
  `/tmp/x.html` can be repointed, so it is no page. A path outside home by spelling only (home
  reached through some other link) keeps its pencil and its bridge, as before.
- The File tab hides the pencil on `outside_home` (`canEdit`) rather than letting a save fail
  after the user typed. `view.panel.file --edit` refuses on `outside_home` too, after `CheckEdit`:
  `/tmp/l.txt` linked to `~/notes.txt` passes `CheckEdit`, because `WriteFile` goes by the real
  file alone, and the verb would report a tab that never opens an editor.
- `view.panel.page` refuses `outside_home`, because `page=1` is what gives a tab the thread's
  bridge. It also covers `~/link.html` pointing into temp, which a check on the path alone would
  miss. A missing temp page answers "no file at", not the refusal.
- `view.inline --panel` cannot reach temp: `ShowHtml` runs first and `htmlPage` refuses it.
- A plain File tab of a temp page has no bridge: `usePageThread` finds no html item and no page
  flag, so every call answers "this page is not shown in a thread".

## Reading what anyone can write

Temp is writable by anything on the machine, so a check on a path says nothing about what a later
open gets. Flipping `/tmp/foo/x.txt` between a file and a link served `daemon.token` within about
30 requests. So in a temp folder the open comes first and the checks are on the open file.

- `ReadFile`: a `real` under home is opened with no link allowed on the way, and a
  `real` in temp through a Root at the deepest temp folder holding it. The open file's stat
  decides what it is. This is why the File tab can still read a `/tmp` link into home.
- The route, temp grant (`preview/open.go`): a grant is a name in a temp folder, not a resolved
  path or an inode. `fsx.OpenTree` walks to it from the temp folder with `O_NOFOLLOW`, so a tree
  swapped for a link is 404 and one swapped for a real folder serves that folder, which is all
  its owner could have put there anyway. An agent's `rm -rf` and rebuild keeps its tab working
  with no new grant, which binding an inode would not. Files open through a Root on that folder.
- A one-file grant takes the file at its name: `Lstat` after the open must be the same file.
- The Floor speaks of paths, so before it is asked the real path must lead to the open file
  (`realOf`). That keeps a config home below a tree guarded, with one known gap: the Floor reads
  markers by path after the open, so a second user who can write in that tree can race it. The
  home must be one the Floor does not know, at least two levels below the tree. The review served
  a file 66 times in 43,560 requests that way. Closing it means walking markers on held
  descriptors, which was judged too much code for a dev daemon's scratch home inside someone
  else's temp tree. A process running as the user needs no race: it can read the file anyway.
  An atomic rewrite landing between the open and that check is a 404 for that request.
- The route, home grant: checks then opens with `O_NOFOLLOW_ANY` (`fsx.NoFollowAny`), and the
  real file must be under home unless the grant is in temp. `ReadFile`'s home branch opens the
  same way. Home is not safe from swaps: `~/Public/Drop Box` is writable by other users, so a
  link swapped in after the check must fail the open. A bridged `~/proj/index.html` cannot load `build/app.js` through
  `~/proj/build -> /tmp/foo`, and `~/site/l.html -> /tmp/a.html -> ~/real.html` serves only while
  it leads home, so repointing `/tmp/a.html` gives a 404, not temp's bytes at a home URL.
  `PreviewFile` refuses such a link up front rather than hand out a URL that 404s.
- Nothing blocks on a FIFO. `os.OpenRoot` and `Root.OpenRoot` open with no `O_NONBLOCK`, so
  `OpenTree` makes its Root from the walked descriptor (`/dev/fd/<n>`). `Root.OpenFile` takes
  `O_NONBLOCK` and opens folders on the way with `O_DIRECTORY`; `os.ReadDir` does too.
- A hard link in temp to a home file the Floor does not guard is served: nothing tells it from a
  file. Home is 0750 group `staff` on a default Mac, so another `staff` user may be able to make
  one. It is left in because refusing `links > 1` would break hard-linked temp builds, and only
  a second user on the machine can use it.
- The marker walk stops below a temp folder: `touch /tmp/daemon.token` must not guard all of
  `/tmp`. A home that is a temp folder itself is only guarded when the Floor knows it.

## Gotchas

- Open in editor and Open in Finder stay on the File tab of a temp file and fail with a toast
  ("outside your home directory"): the gitops rule was kept on purpose.
- A plain temp page has an opaque origin and no storage, like any File tab page. A page can still
  `fetch()` its own grant, as the route sends `Access-Control-Allow-Origin: *`, and it has the
  network, so what a grant serves is what a stranger's page can send anywhere.
- A link in a temp folder can 404 in the preview and still read in the File tab, as the check is
  on what a page can fetch, not on what the user opens. A link out of the tree, a one-file grant's
  link, a folder spelled through a link inside temp and an absolute link (a Root takes none, even
  inside its tree) are all 404. A relative link inside the tree works.
- `/tmp/claude-<uid>` is an ordinary folder to the floor: a page directly in it gets the whole
  folder as its tree.
- The daemon's `$TMPDIR` is what counts. A daemon started without one has only `/tmp`.
- `make drive` cannot show images: the CLI's `allowedOrigins` blocks `blob:`, for a home image as
  much as a temp one. The bytes are right; decoding them from a data URL works.
