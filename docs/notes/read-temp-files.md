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
- A root that holds home is dropped, spelled or resolved. A `TMPDIR` of `/`, home or a parent of
  home would otherwise open everything to the file viewer. A relative `TMPDIR` is dropped too.
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
  after the user typed. `view.panel.file --edit` is refused by `CheckEdit` as before.
- `view.panel.page` refuses `outside_home`, because `page=1` is what gives a tab the thread's
  bridge. It also covers `~/link.html` pointing into temp, which a check on the path alone would
  miss. A missing temp page answers "no file at", not the refusal.
- `view.inline --panel` cannot reach temp: `ShowHtml` runs first and `htmlPage` refuses it.
- A plain File tab of a temp page has no bridge: `usePageThread` finds no html item and no page
  flag, so every call answers "this page is not shown in a thread".

## Gotchas

- Open in editor and Open in Finder stay on the File tab of a temp file and fail with a toast
  ("outside your home directory"): the gitops rule was kept on purpose.
- A link from a temp tree into home is served, unless the floor guards the target, because the
  route has one rule: home or temp. A page in temp can therefore read an unguarded home file
  through a link someone placed beside it. Tightening it means a temp grant serves only temp, and
  PreviewFile refusing what the route would 404.
- A temp page is on the pages origin like any other preview, so it shares that origin's storage.
- `/tmp/claude-<uid>` is an ordinary folder to the floor: a page directly in it gets the whole
  folder as its tree.
- The daemon's `$TMPDIR` is what counts. A daemon started without one has only `/tmp`.
- `make drive` cannot show images: the CLI's `allowedOrigins` blocks `blob:`, for a home image as
  much as a temp one. The bytes are right; decoding them from a data URL works.
